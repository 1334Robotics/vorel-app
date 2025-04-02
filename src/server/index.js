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

// Mount API routes at the root path
app.use('/', apiRoutes);

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
