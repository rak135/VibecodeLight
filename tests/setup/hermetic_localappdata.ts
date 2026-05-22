import fs from 'fs';
import os from 'os';
import path from 'path';

// Point LOCALAPPDATA at an isolated, empty temp directory so that no test
// (in-process or spawned CLI subprocess that inherits process.env) ever reads
// the real machine's %LOCALAPPDATA%\vibecodelight global config or .env.
//
// Each test file gets its own empty temp dir. The `vibecodelight` subdirectory
// is intentionally NOT created, so global config/env resolve as absent unless a
// test explicitly opts in by overriding the paths or LOCALAPPDATA itself.
const hermeticLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-test-localappdata-'));
process.env.LOCALAPPDATA = hermeticLocalAppData;
