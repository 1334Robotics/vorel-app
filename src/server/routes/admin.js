const express = require('express');
const router = express.Router();
const { requireAuth } = require('../helpers/auth');
const { getKeyStatus } = require('../helpers/encryption');
const { pool } = require('../helpers/database');

// Middleware to check if database mode is enabled
function requireDatabaseMode(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      error: 'Database mode is not enabled',
      message: 'User management requires database functionality'
    });
  }
  next();
}

// Admin dashboard route (protected)
router.get('/', requireAuth, (req, res) => {
  res.render('dashboard/admin/index', {
    user: req.user
  });
});

// Notices management route (protected)
router.get('/notices', requireAuth, (req, res) => {
  res.render('dashboard/admin/notices', {
    user: req.user
  });
});

// User management route (protected, requires database mode)
router.get('/users', requireAuth, requireDatabaseMode, (req, res) => {
  res.render('dashboard/admin/users', {
    user: req.user
  });
});

// Get list of admin users (API endpoint)
router.get('/users/list', requireAuth, requireDatabaseMode, async (req, res) => {
  try {
    const { getAllAdminUsers } = require('../helpers/database');
    
    // Get admin users from database
    const dbUsers = await getAllAdminUsers();
    
    // Get environment users for protection
    const envUsers = process.env.AUTHORIZED_GITHUB_USERS ? 
      process.env.AUTHORIZED_GITHUB_USERS.split(',').map(u => u.trim().toLowerCase()) : [];
    
    // Mark environment users as protected
    const users = dbUsers.map(user => ({
      ...user,
      source: envUsers.includes(user.github_username.toLowerCase()) ? 'env' : 'db'
    }));
    
    res.json(users);
  } catch (error) {
    console.error('Error getting admin users:', error);
    res.status(500).json({ error: 'Failed to get admin users' });
  }
});

// Add new admin user (API endpoint)
router.post('/users/add', requireAuth, requireDatabaseMode, async (req, res) => {
  try {
    const { github_username, role } = req.body;
    
    if (!github_username || !role) {
      return res.status(400).json({ 
        success: false, 
        message: 'Username and role are required' 
      });
    }
    
    // Validate role
    if (!['admin', 'moderator'].includes(role)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid role. Must be admin or moderator' 
      });
    }
    
    // Validate username format
    if (!/^[a-zA-Z0-9\-_]+$/.test(github_username)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid username format' 
      });
    }
    
    const { addAdminUser } = require('../helpers/database');
    const success = await addAdminUser(
      github_username.trim(),
      null, // Will be updated when user logs in
      role,
      true
    );
    
    if (success) {
      // Check if this is an HTML form submission or API call
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        res.json({ success: true, message: 'User added successfully' });
      } else {
        res.redirect('/admin/users?success=User added successfully');
      }
    } else {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        res.status(500).json({ 
          success: false, 
          message: 'Failed to add user to database' 
        });
      } else {
        res.redirect('/admin/users?error=Failed to add user to database');
      }
    }
  } catch (error) {
    console.error('Error adding admin user:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// Toggle user active status (API endpoint)
router.post('/users/toggle', requireAuth, requireDatabaseMode, async (req, res) => {
  try {
    const { username, is_active } = req.body;
    
    if (!username || typeof is_active !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        message: 'Username and active status are required' 
      });
    }
    
    // Prevent users from deactivating themselves
    if (req.user && req.user.username && req.user.username.toLowerCase() === username.toLowerCase() && !is_active) {
      return res.status(403).json({ 
        success: false, 
        message: 'Cannot deactivate your own account' 
      });
    }
    
    const { toggleAdminUser } = require('../helpers/database');
    const success = await toggleAdminUser(username, is_active);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
  } catch (error) {
    console.error('Error toggling user status:', error);
    
    if (error.message.includes('environment-defined')) {
      return res.status(403).json({ 
        success: false, 
        message: error.message 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update user status' 
    });
  }
});

// Remove admin user (API endpoint)
router.post('/users/remove', requireAuth, requireDatabaseMode, async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ 
        success: false, 
        message: 'Username is required' 
      });
    }
    
    // Prevent users from removing themselves
    if (req.user && req.user.username && req.user.username.toLowerCase() === username.toLowerCase()) {
      return res.status(403).json({ 
        success: false, 
        message: 'Cannot remove your own account' 
      });
    }
    
    const { removeAdminUser } = require('../helpers/database');
    const success = await removeAdminUser(username);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
  } catch (error) {
    console.error('Error removing user:', error);
    
    if (error.message.includes('environment-defined')) {
      return res.status(403).json({ 
        success: false, 
        message: error.message 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to remove user' 
    });
  }
});

// List all admin users (API endpoint)
router.get('/system-status', requireAuth, async (req, res) => {
  try {
    const { getDBStats } = require('../helpers/database');
    
    // Check database status without creating new connections
    // Just check if pool exists, don't test connection every time
    let dbConnected = !!pool;
    let dbStats = null;
    
    if (dbConnected) {
      try {
        const rawStats = await getDBStats();
        // Convert BigInt values to regular numbers for JSON serialization
        dbStats = {
          total_events: Number(rawStats.total_events || 0),
          years_count: Number(rawStats.years_count || 0)
        };
      } catch (error) {
        console.error('Error getting database stats:', error);
        // If we can't get stats, the database might be disconnected
        dbConnected = false;
      }
    }
    
    // Get encryption key status
    const encryptionStatus = await getKeyStatus();
    
    // Get server status
    const serverStatus = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      timestamp: Date.now()
    };
    
    // Get webhook statistics from API routes
    let webhookStats = null;
    try {
      const response = await fetch(`http://localhost:${process.env.PORT || 3002}/api/webhook-stats`);
      if (response.ok) {
        webhookStats = await response.json();
      }
    } catch (error) {
      console.warn('Could not fetch webhook stats:', error.message);
    }
    
    // Get SSE connection statistics
    let sseStats = null;
    try {
      const response = await fetch(`http://localhost:${process.env.PORT || 3002}/api/sse-stats`);
      if (response.ok) {
        sseStats = await response.json();
      }
    } catch (error) {
      console.warn('Could not fetch SSE stats:', error.message);
    }
    
    const status = {
      database: {
        connected: dbConnected,
        stats: dbStats
      },
      encryption: encryptionStatus,
      server: serverStatus,
      webhook: webhookStats,
      sse: sseStats
    };
    
    res.json(status);
  } catch (error) {
    console.error('Error getting system status:', error);
    res.status(500).json({ 
      error: 'Failed to get system status',
      message: error.message 
    });
  }
});

// Future admin routes can be added here
// router.get('/users', requireAuth, (req, res) => {
//   res.render('dashboard/admin/users', {
//     user: req.user
//   });
// });

// router.get('/settings', requireAuth, (req, res) => {
//   res.render('dashboard/admin/settings', {
//     user: req.user
//   });
// });

module.exports = router;
