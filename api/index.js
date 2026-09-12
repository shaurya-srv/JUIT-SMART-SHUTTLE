// Vercel serverless entry point — exposes the Express app to @vercel/node.
// Path is relative to this file: server.js lives one directory up, in server/.
const app = require('../server/server');

module.exports = app;
