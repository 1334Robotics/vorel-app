const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

console.log(`Vorel Copyright (C) 2025 1334Robotics
This program comes with ABSOLUTELY NO WARRANTY.
This is free software, and you are welcome to redistribute it
under certain conditions. TO VIEW THE LICENSE VISIT OUR [GITHUB](https://github.com/1334Robotics/vorel-app/blob/main/LICENSE)
`);

const app = express();
const Routes = require("./routes/apex");
const apiRoutes = require("./routes/api");
const embedRoutes = require("./routes/embed");
const { initializeEventCache } = require("./helpers/api"); // Add this line near the top of src/server/index.js after importing routes

// Middleware
app.use(cors());
app.use(express.json());
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
      // Remove HTML comments and CSS comment blocks in inline styles
      const cleanedHtml = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      if (callback) return callback(null, cleanedHtml);
      res.send(cleanedHtml);
    });
  };
  next();
});

// Set up EJS as the view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../../views"));

app.use(express.static(path.join(__dirname, "../../views/public")));

// Serve favicon.ico using the icon.avif file
app.get("/favicon.ico", (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
