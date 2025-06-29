const express = require('express');
const router = express.Router();
const { passport, requireAuth } = require('../helpers/auth');

// Login page
router.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    // Already logged in, redirect to admin or return URL
    const returnTo = req.session.returnTo || '/admin';
    delete req.session.returnTo;
    return res.redirect(returnTo);
  }
  
  // Render login page
  res.render('dashboard/admin/login', {
    error: req.query.error || null,
    returnTo: req.query.returnTo || null
  });
});

// GitHub OAuth initiation
router.get('/github', passport.authenticate('github', { 
  scope: ['user:email'] 
}));

// GitHub OAuth callback
router.get('/github/callback', 
  passport.authenticate('github', { 
    failureRedirect: '/auth/login?error=auth_failed' 
  }),
  (req, res) => {
    // Successful authentication
    const returnTo = req.session.returnTo || '/admin';
    delete req.session.returnTo;
    
    console.log(`User ${req.user.username} successfully authenticated`);
    res.redirect(returnTo);
  }
);

// Logout
router.post('/logout', requireAuth, (req, res) => {
  const username = req.user?.username;
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destroy error:', err);
      }
      
      console.log(`User ${username} logged out`);
      res.clearCookie('connect.sid'); // Clear session cookie
      res.redirect('/');
    });
  });
});

// Logout (GET version for direct browser access)
router.get('/logout', requireAuth, (req, res) => {
  const username = req.user?.username;
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.redirect('/?error=logout_failed');
    }
    
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destroy error:', err);
      }
      
      console.log(`User ${username} logged out`);
      res.clearCookie('connect.sid'); // Clear session cookie
      res.redirect('/');
    });
  });
});

// Check authentication status (API endpoint)
router.get('/status', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      authenticated: true,
      user: {
        username: req.user.username,
        displayName: req.user.displayName,
        email: req.user.email,
        avatarUrl: req.user.avatarUrl
      }
    });
  } else {
    res.json({
      authenticated: false,
      loginUrl: '/auth/login'
    });
  }
});

module.exports = router;
