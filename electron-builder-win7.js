// Legacy build config: 32-bit (ia32) installer that runs on Windows 7 / 8 / 8.1.
//
// Why a separate config: Electron 23+ (Chromium 110) DROPPED Windows 7/8/8.1 support, so
// the normal build (Electron 29, x64) cannot start on Win7. Electron 22 is the last
// release that supports it. This config packages the same app code with Electron 22 for
// ia32, leaving package.json's main build (modern Windows, x64) completely untouched.
//
// Build with:  npm run build:win7      ->  dist-win7/
//
// ia32 also runs on 64-bit Windows, so this one installer covers any Win7+ machine.
// Note: main.js skips auto-update on Win7/8 (published releases are Win10-only builds),
// so legacy machines are updated by re-running this installer.

const base = require("./package.json").build;

module.exports = {
  ...base,
  // Last Electron release supporting Windows 7 / 8 / 8.1.
  electronVersion: "22.3.27",
  directories: { ...base.directories, output: "dist-win7" },
  win: {
    ...base.win,
    target: [{ target: "nsis", arch: ["ia32"] }],
  },
  artifactName: "${productName} Setup ${version} (Win7-32bit).${ext}",
};
