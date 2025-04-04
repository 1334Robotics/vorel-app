const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const apiRoutes = require('./routes');

// Middleware
app.use(cors());
app.use(express.json());

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../../views'));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../../views/public')));

// Serve favicon.ico using the icon.png file
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/public/icon.png'));
});

// Mount API routes at the root path
app.use('/', apiRoutes);

// Add 404 handler for all unmatched routes
app.use((req, res) => {
  res.status(404).render('pages/404');
});

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
