const express = require("express");
const cors = require("cors");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

console.log(`Vorel Copyright (C) 2025 1334Robotics
This program comes with ABSOLUTELY NO WARRANTY.
This is free software, and you are welcome to redistribute it
under certain conditions. TO VIEW THE LICENSE VISIT OUR [GITHUB](https://github.com/1334Robotics/vorel-app/blob/main/LICENSE)
`);

// Initialize database connection
const { initializeDB } = require("./helpers/database");
const { initializeChangelog } = require("./helpers/changelog");

const app = express();
const Routes = require("./routes/apex");
const apiRoutes = require("./routes/api");
const embedRoutes = require("./routes/embed");
const { initializeEventCacheEnhanced } = require("./helpers/api");

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());
// Security headers
app.use((req, res, next) => {
  // HTTP Strict-Transport-Security
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // X-Content-Type-Options
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
// Strip HTML comments from rendered views
app.use((req, res, next) => {
  const originalRender = res.render;
  res.render = function(view, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    originalRender.call(this, view, options, (err, html) => {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }      // Remove HTML comments, CSS comment blocks, and JavaScript comments
      let cleanedHtml = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      
      // Remove JavaScript single-line comments only within script tags
      cleanedHtml = cleanedHtml.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, scriptContent) => {
        const cleanedScript = scriptContent.replace(/\/\/.*$/gm, '');
        return match.replace(scriptContent, cleanedScript);
      });
      if (callback) return callback(null, cleanedHtml);
      res.send(cleanedHtml);
    });
  };
  next();
});

// Set up EJS as the view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../../views"));

const staticOptions = {
  maxAge: '7d',
  immutable: false
};
app.use(express.static(path.join(__dirname, "../../views/public"), staticOptions));

// Serve favicon.ico using the icon.avif file
app.get("/favicon.ico", (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(__dirname, "../../views/public/icon.avif"));
});

app.use("/", Routes);
app.use("/api", apiRoutes);
app.use("/embed", embedRoutes);

// Add 404 handler for all unmatched routes
app.use((req, res) => {
  res.status(404).render("pages/404");
});

const PORT = process.env.PORT || 3002;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize event cache, database, and changelog after server starts
  initializeEventCacheEnhanced();
  initializeChangelog();
});

// Configure server timeouts for Cloudflare compatibility
server.timeout = 90000; // 90 seconds - under Cloudflare's 100-second timeout
server.keepAliveTimeout = 85000; // 85 seconds
server.headersTimeout = 86000; // 86 seconds (should be longer than keepAliveTimeout)

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  const { closeDB } = require('./helpers/database');
  await closeDB();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  const { closeDB } = require('./helpers/database');
  await closeDB();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
