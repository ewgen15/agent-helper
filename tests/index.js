'use strict';
// Entry point for `node --test tests/`. On Node 21+ a directory argument is loaded as a
// module (CJS resolves it to this index.js), so the suites are required from here.
require('./server.test.js');
require('./ui.test.js');
require('./code.test.js');
