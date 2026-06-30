import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Squirrel groups the Start Menu shortcut under a folder named after the
    // EXE's CompanyName (which @electron/packager otherwise takes from
    // package.json `author.name` = "eschgr"). Set it to the product name so the
    // shortcut lands under Programs\Galley\, not Programs\eschgr\.
    win32metadata: {
      CompanyName: 'Galley',
    },
  },
  rebuildConfig: {},
  makers: [
    // Install to %LocalAppData%\Galley: the Squirrel package id (the install
    // folder) defaults to the package.json `name` ("galley"); override to Galley.
    // (The Start Menu shortcut folder is the EXE CompanyName, set above — NOT the
    // nuspec `authors`, which Squirrel ignores for shortcuts.)
    new MakerSquirrel({ name: 'Galley' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      // Re-apply an ad-hoc signature after flipping fuses. On Apple Silicon any
      // fuse flip modifies the binary and invalidates Electron's ad-hoc code
      // signature, so an unsigned arm64 build is killed on launch — this resets
      // it. https://www.electronjs.org/docs/latest/tutorial/fuses
      resetAdHocDarwinSignature: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // OFF: with this on, the packaged app instantly exits on macOS
      // (electron/fuses#7). We don't code-sign/notarize, so the ASAR integrity
      // header isn't validated reliably on macOS; keep it off so the build runs.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
