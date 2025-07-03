const express = require("express");
const cors = require("cors");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
require("dotenv").config();

console.log(`Vorel Copyright (C) 2025 1334Robotics
This program comes with ABSOLUTELY NO WARRANTY.
This is free software, and you are welcome to redistribute it
under certain conditions. TO VIEW THE LICENSE VISIT OUR [GITHUB](https://github.com/1334Robotics/vorel-app/blob/main/LICENSE)
`);

// Initialize database connection
const { initializeDB, initializeAdminUsers } = require("./helpers/database");
const { initializeChangelog } = require("./helpers/changelog");
const { initializeAuth, checkAuthConfig, passport, updateAdminCache } = require("./helpers/auth");
const { initializeEncryption, getNextRotationTime, KEY_ROTATION_INTERVAL } = require("./helpers/encryption");

const app = express();
const Routes = require("./routes/apex");
const apiRoutes = require("./routes/api");
const embedRoutes = require("./routes/embed");
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const { initializeEventCacheEnhanced } = require("./helpers/api");

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize encryption and start server
async function startServer() {
  // Initialize encryption system
  const encryptionKey = await initializeEncryption();
  
  // Session configuration with dynamic encryption key and secure settings
  const nextRotationTime = getNextRotationTime();
  const timeUntilRotation = nextRotationTime.getTime() - Date.now();
  const sessionMaxAge = Math.min(KEY_ROTATION_INTERVAL, Math.max(timeUntilRotation, 60 * 60 * 1000)); // Minimum 1 hour
  
  console.log(`Session max age set to: ${Math.floor(sessionMaxAge / 1000 / 60)} minutes`);
  
  app.use(session({
    secret: encryptionKey,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
      httpOnly: true,
      maxAge: sessionMaxAge, // Expire with key rotation
      sameSite: 'lax' // Allow OAuth redirects while maintaining security
    },
    name: 'vorel.sid' // Custom session name
  }));

  // Initialize Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Security headers
  app.use((req, res, next) => {
    // HTTP Strict-Transport-Security
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    // X-Content-Type-Options
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options
    res.setHeader('X-Frame-Options', 'DENY');
    // X-XSS-Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Content Security Policy for admin pages
    if (req.path.startsWith('/admin')) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self';");
    }
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
        }
        
        // Remove HTML comments, CSS comment blocks, and JavaScript comments
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

  // Check authentication configuration first
  const authConfigured = checkAuthConfig();
  if (authConfigured) {
    initializeAuth();
    console.log('Authentication system initialized');
  } else {
    console.log('Authentication system disabled - missing configuration');
  }

  app.use("/", Routes);
  app.use("/api", apiRoutes);
  app.use("/embed", embedRoutes);
  
  // Only register auth and admin routes if authentication is configured
  if (authConfigured) {
    app.use("/auth", authRoutes);
    app.use("/admin", adminRoutes);
  } else {
    // Provide fallback routes when auth is disabled
    app.use("/auth/*", (req, res) => {
      res.status(503).json({ 
        error: 'Authentication system unavailable',
        message: 'GitHub OAuth is not configured on this server'
      });
    });
    app.use("/admin/*", (req, res) => {
      res.status(503).json({ 
        error: 'Admin system unavailable',
        message: 'Authentication is required for admin access'
      });
    });
  }

  // Add 404 handler for all unmatched routes
  app.use((req, res) => {
    res.status(404).render("pages/404");
  });

  const PORT = process.env.PORT || 3002;

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    
    // Initialize admin cache if auth is configured
    if (authConfigured) {
      updateAdminCache().catch(error => {
        console.error('Failed to initialize admin cache:', error);
      });
    }
    
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
}

// Start the server
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
