const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const { isAuthorizedAdmin, initializeAdminUsers } = require('./database');

// Admin cache to reduce database queries
let adminCache = {
  users: new Set(),
  lastUpdated: 0,
  cacheTimeout: 5 * 60 * 1000, // 5 minutes
  databaseMode: null, // null = unknown, true = database available, false = env only
  databaseChecked: false
};

// Check if database is available for admin management
async function checkDatabaseMode() {
  if (adminCache.databaseChecked) {
    return adminCache.databaseMode;
  }
  
  try {
    const { pool } = require('./database');
    if (!pool) {
      adminCache.databaseMode = false;
      adminCache.databaseChecked = true;
      return false;
    }
    
    // Test database connection without creating a new one
    const connection = await pool.getConnection();
    const result = await connection.query('SELECT COUNT(*) as count FROM admin_users');
    connection.release();
    
    adminCache.databaseMode = true;
    adminCache.databaseChecked = true;
    console.log('Database mode enabled for admin management');
    return true;
  } catch (error) {
    adminCache.databaseMode = false;
    adminCache.databaseChecked = true;
    console.log('Database mode disabled, using environment variables');
    return false;
  }
}

// Update admin cache from database or environment
async function updateAdminCache() {
  try {
    const isDatabaseMode = await checkDatabaseMode();
    
    if (isDatabaseMode) {
      // Get admin users directly from database without extra connection
      const { pool } = require('./database');
      const connection = await pool.getConnection();
      const adminUsers = await connection.query('SELECT * FROM admin_users WHERE is_active = 1');
      connection.release();
      
      adminCache.users.clear();
      adminUsers.forEach(admin => {
        adminCache.users.add(admin.github_username.toLowerCase());
      });
    } else {
      // Use environment variables
      const envAdmins = process.env.ADMIN_GITHUB_USERS ? process.env.ADMIN_GITHUB_USERS.split(',') : [];
      adminCache.users.clear();
      envAdmins.forEach(username => {
        adminCache.users.add(username.trim().toLowerCase());
      });
    }
    
    adminCache.lastUpdated = Date.now();
    console.log(`Admin cache updated: ${adminCache.users.size} users, database mode: ${adminCache.databaseMode}`);
  } catch (error) {
    console.error('Error updating admin cache:', error);
    // Fall back to environment variables on error
    adminCache.databaseMode = false;
    const envAdmins = process.env.ADMIN_GITHUB_USERS ? process.env.ADMIN_GITHUB_USERS.split(',') : [];
    adminCache.users.clear();
    envAdmins.forEach(username => {
      adminCache.users.add(username.trim().toLowerCase());
    });
    adminCache.lastUpdated = Date.now();
  }
}

// Check if admin cache needs refreshing
function isAdminCacheStale() {
  return (Date.now() - adminCache.lastUpdated) > adminCache.cacheTimeout;
}

// Fast admin authorization check using cache
async function isAdminAuthorized(username) {
  if (isAdminCacheStale()) {
    await updateAdminCache();
  }
  
  return adminCache.users.has(username.toLowerCase());
}

// Reset database mode check (called when admin users are modified)
function resetDatabaseModeCheck() {
  adminCache.databaseChecked = false;
  adminCache.databaseMode = null;
}

// Configure GitHub OAuth strategy
function initializeAuth() {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // Check if user is authorized using database-based admin management
      const isAuthorized = await isAdminAuthorized(profile.username);
      
      if (!isAuthorized) {
        console.log(`Access denied for ${profile.username} - not an authorized admin`);
        return done(null, false, { message: 'User not authorized' });
      }
      
      // Create user object with relevant information
      const user = {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        email: profile.emails?.[0]?.value || null,
        avatarUrl: profile.photos?.[0]?.value || null,
        profileUrl: profile.profileUrl,
        accessToken: accessToken
      };
      
      console.log(`Admin authenticated: ${user.username} (${user.displayName})`);
      return done(null, user);
    } catch (error) {
      console.error('Authentication error:', error);
      return done(error, null);
    }
  }));

  // Serialize user for session
  passport.serializeUser((user, done) => {
    // Store a sessionIssued timestamp for session expiration logic
    done(null, {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      sessionIssued: Date.now()
    });
  });

  // Deserialize user from session
  passport.deserializeUser((user, done) => {
    // Check if session is older than 48 hours (172800000 ms)
    const now = Date.now();
    if (user.sessionIssued && (now - user.sessionIssued > 172800000)) {
      // Session is older than 48 hours, force re-authentication
      return done(null, false);
    }
    done(null, user);
  });
}

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  
  // Store the original URL they were trying to access
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
}

// Middleware to check if user is authenticated (API version)
function requireAuthAPI(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  
  res.status(401).json({ 
    error: 'Authentication required',
    loginUrl: '/auth/login'
  });
}

// Check if authentication is properly configured
function checkAuthConfig() {
  const required = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];
  const missing = required.filter(key => !process.env[key] || process.env[key].trim() === '');
  
  if (missing.length > 0) {
    console.error('Missing required environment variables for GitHub OAuth:');
    missing.forEach(key => {
      const value = process.env[key];
      if (!value) {
        console.error(`   - ${key}: not set`);
      } else if (value.trim() === '') {
        console.error(`   - ${key}: empty string`);
      }
    });
    console.error('   Please set these in your .env file or environment');
    console.error('   Authentication routes will be disabled until configured');
    return false;
  }
  
  // Additional validation
  if (!process.env.GITHUB_CALLBACK_URL) {
    console.warn('Warning: GITHUB_CALLBACK_URL not set, using default');
  }
  
  console.log('GitHub OAuth configuration found');
  console.log(`   Client ID: ${process.env.GITHUB_CLIENT_ID.substring(0, 8)}...`);
  console.log(`   Callback URL: ${process.env.GITHUB_CALLBACK_URL || 'not set'}`);
  return true;
}

module.exports = {
  initializeAuth,
  requireAuth,
  requireAuthAPI,
  checkAuthConfig,
  passport,
  updateAdminCache,
  isAdminAuthorized,
  resetDatabaseModeCheck
};
