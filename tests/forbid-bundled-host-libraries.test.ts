// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  forbidBundledHostLibraries,
  hostProvidedPackage,
} from '../scripts/forbid-bundled-host-libraries.mjs';

describe('hostProvidedPackage', () => {
  it('matches host-provided packages, scopes and subpaths', () => {
    expect(hostProvidedPackage('@deck.gl/core')).toBe('@deck.gl/');
    expect(hostProvidedPackage('@luma.gl/engine')).toBe('@luma.gl/');
    expect(hostProvidedPackage('deck.gl')).toBe('deck.gl');
    expect(hostProvidedPackage('maplibre-gl-lidar')).toBe('maplibre-gl-lidar');
    expect(hostProvidedPackage('maplibre-gl-raster/style.css')).toBe('maplibre-gl-raster');
  });

  it('ignores other packages and paths', () => {
    expect(hostProvidedPackage('maplibre-gl')).toBeNull();
    expect(hostProvidedPackage('maplibre-gl-lidar-extra')).toBeNull();
    expect(hostProvidedPackage('deck.gl-utils')).toBeNull();
    expect(hostProvidedPackage('./maplibre-gl-lidar')).toBeNull();
    expect(hostProvidedPackage('/abs/@deck.gl/core')).toBeNull();
    expect(hostProvidedPackage('\0virtual:@deck.gl/core')).toBeNull();
  });
});

describe('forbidBundledHostLibraries in a build', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'forbid-host-libs-'));
    await writeFile(
      join(dir, 'value.ts'),
      'import { PointCloudLoader } from "maplibre-gl-lidar";\nexport const L = PointCloudLoader;\n',
    );
    await writeFile(
      join(dir, 'type-only.ts'),
      'import type { PointCloudData } from "maplibre-gl-lidar";\n' +
        'export const count = (d: PointCloudData) => d.pointCount;\n',
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (entry: string) =>
    build({
      configFile: false,
      logLevel: 'silent',
      root: dir,
      plugins: [forbidBundledHostLibraries()],
      build: {
        write: false,
        lib: { entry: join(dir, entry), formats: ['es'], fileName: 'out' },
      },
    });

  it('fails on a value import, naming the package and the fix', async () => {
    await expect(run('value.ts')).rejects.toThrow(/maplibre-gl-lidar.*must not be bundled/s);
  });

  it('passes a type-only import', async () => {
    await expect(run('type-only.ts')).resolves.toBeDefined();
  });
});
