// UMD globals from the <script> tags in index.html (/vendor/xterm.js and /vendor/addon-fit.js).
// No top-level import/export: this file must stay a global script declaration.
declare const Terminal: typeof import('@xterm/xterm').Terminal;
declare const FitAddon: { FitAddon: typeof import('@xterm/addon-fit').FitAddon };
