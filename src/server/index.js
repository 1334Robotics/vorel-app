const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

console.log(`Vorel Copyright (C) 2025 1334Robotics
This program comes with ABSOLUTELY NO WARRANTY.
This is free software, and you are welcome to redistribute it
under certain conditions. TO VIEW THE LICENSE VISIT OUR [GITHUB](https://github.com/1334Robotics/vorel-app/blob/main/LICENSE)
`)

const app = express();
const Routes = require('./routes/apex');
const apiRoutes = require('./routes/api');
const { initializeEventCache } = require('./helpers/api'); // Add this line near the top of src/server/index.js after importing routes

// Middleware
app.use(cors());
app.use(express.json());

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../../views'));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../../views/public')));

// Serve favicon.ico using the icon.avif file
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/public/icon.avif'));
});


app.use('/', Routes);
app.use('/api', apiRoutes);

// Add 404 handler for all unmatched routes
app.use((req, res) => {
  res.status(404).render('pages/404');
});

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
