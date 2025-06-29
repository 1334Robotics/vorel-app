const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const KEY_ROTATION_INTERVAL = 48 * 60 * 60 * 1000; // 48 hours in milliseconds
const KEY_FILE_PATH = path.join(__dirname, '..', '..', '..', '.encryption-key.json');

// Generate a new encryption key
function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('hex'); // 256-bit key
}

// Get or create encryption key data
async function getEncryptionKeyData() {
  try {
    const data = await fs.readFile(KEY_FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is corrupted, create new key data
    const keyData = {
      key: generateEncryptionKey(),
      createdAt: Date.now(),
      lastRotated: Date.now(),
      rotationInterval: KEY_ROTATION_INTERVAL
    };
    
    await saveEncryptionKeyData(keyData);
    console.log('New encryption key generated and saved');
    return keyData;
  }
}

// Save encryption key data
async function saveEncryptionKeyData(keyData) {
  try {
    await fs.writeFile(KEY_FILE_PATH, JSON.stringify(keyData, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save encryption key data:', error.message);
    throw error;
  }
}

// Check if key needs rotation and rotate if necessary
async function checkAndRotateKey() {
  try {
    const keyData = await getEncryptionKeyData();
    const now = Date.now();
    const timeSinceLastRotation = now - keyData.lastRotated;
    
    if (timeSinceLastRotation >= KEY_ROTATION_INTERVAL) {
      console.log('Encryption key rotation due - generating new key');
      
      keyData.key = generateEncryptionKey();
      keyData.lastRotated = now;
      
      await saveEncryptionKeyData(keyData);
      console.log('Encryption key rotated successfully');
      
      return keyData.key;
    } else {
      const hoursUntilRotation = Math.ceil((KEY_ROTATION_INTERVAL - timeSinceLastRotation) / (60 * 60 * 1000));
      console.log(`Encryption key is current - next rotation in ${hoursUntilRotation} hours`);
      return keyData.key;
    }
  } catch (error) {
    console.error('Error during key rotation check:', error.message);
    // Fall back to generating a new key
    const newKey = generateEncryptionKey();
    console.log('Using fallback encryption key');
    return newKey;
  }
}

// Get current encryption key (with automatic rotation check)
async function getCurrentEncryptionKey() {
  return await checkAndRotateKey();
}

// Initialize encryption system
async function initializeEncryption() {
  try {
    const key = await getCurrentEncryptionKey();
    console.log('Encryption system initialized');
    
    // Set up periodic key rotation checks
    setInterval(async () => {
      await checkAndRotateKey();
    }, 60 * 60 * 1000); // Check every hour
    
    return key;
  } catch (error) {
    console.error('Failed to initialize encryption system:', error.message);
    return generateEncryptionKey(); // Fallback
  }
}

// Get key status for monitoring
async function getKeyStatus() {
  try {
    const keyData = await getEncryptionKeyData();
    const now = Date.now();
    const timeSinceLastRotation = now - keyData.lastRotated;
    const timeUntilNextRotation = KEY_ROTATION_INTERVAL - timeSinceLastRotation;
    
    return {
      createdAt: new Date(keyData.createdAt).toISOString(),
      lastRotated: new Date(keyData.lastRotated).toISOString(),
      hoursUntilNextRotation: Math.ceil(timeUntilNextRotation / (60 * 60 * 1000)),
      rotationIntervalHours: KEY_ROTATION_INTERVAL / (60 * 60 * 1000)
    };
  } catch (error) {
    return {
      error: 'Unable to get key status',
      message: error.message
    };
  }
}

// Get the next key rotation time (for setting session expiry)
function getNextRotationTime() {
  const keyData = getEncryptionKeyDataSync();
  if (!keyData) {
    return new Date(Date.now() + KEY_ROTATION_INTERVAL);
  }
  return new Date(keyData.lastRotated + KEY_ROTATION_INTERVAL);
}

// Synchronous version of getEncryptionKeyData for session configuration
function getEncryptionKeyDataSync() {
  try {
    const fs = require('fs');
    const data = fs.readFileSync(KEY_FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

module.exports = {
  initializeEncryption,
  getCurrentEncryptionKey,
  getKeyStatus,
  generateEncryptionKey,
  getNextRotationTime,
  KEY_ROTATION_INTERVAL
};
