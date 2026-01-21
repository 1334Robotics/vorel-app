const https = require('https');

// Cache for changelog data
let changelogCache = null;
let lastFetchTime = null;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds

/**
 * Makes HTTPS request to GitHub API
 */
function makeGitHubRequest(url) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: url,
      method: 'GET',
      headers: {
        'User-Agent': 'Vorel-App/1.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve(jsonData);
        } catch (error) {
          reject(new Error('Failed to parse JSON response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.setTimeout(10000, () => {
      req.abort();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Fetch commits from GitHub API
 */
async function fetchGitHubCommits() {
  try {
    console.log('Fetching GitHub commits for changelog...');

    // Fetch commits (last 100)
    const commits = await makeGitHubRequest('/repos/1334Robotics/vorel-app/commits?per_page=100&sha=main');
    
    if (!Array.isArray(commits)) {
      throw new Error('Invalid commits response from GitHub API');
    }

    // Group commits by date
    const commitsByDate = {};
    
    commits.forEach(commit => {
      const commitDate = new Date(commit.commit.author.date);
      const dateKey = commitDate.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      
      if (!commitsByDate[dateKey]) {
        commitsByDate[dateKey] = {
          date: dateKey,
          timestamp: commitDate.getTime(),
          commits: []
        };
      }
      
      // Clean up commit message and add useful info
      const commitMessage = commit.commit.message.split('\n')[0]; // First line only
      const author = commit.commit.author.name;
      const sha = commit.sha.substring(0, 7); // Short SHA
      const url = commit.html_url;
      
      commitsByDate[dateKey].commits.push({
        message: commitMessage,
        author: author,
        sha: sha,
        url: url,
        time: commitDate.toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit' 
        })
      });
    });
    
    // Convert to array and sort by date (newest first)
    const sortedDays = Object.values(commitsByDate)
      .sort((a, b) => b.timestamp - a.timestamp);
    
    console.log(`Successfully fetched and organized ${commits.length} commits into ${sortedDays.length} days`);
    return sortedDays;
    
  } catch (error) {
    console.error('Error fetching GitHub commits:', error.message);
    return [];
  }
}

/**
 * Get changelog data with caching
 */
async function getChangelogData() {
  const now = Date.now();
  
  // Return cached data if it's still fresh
  if (changelogCache && lastFetchTime && (now - lastFetchTime) < CACHE_DURATION) {
    console.log('Returning cached changelog data');
    return changelogCache;
  }
  
  // Fetch fresh data
  try {
    const freshData = await fetchGitHubCommits();
    changelogCache = freshData;
    lastFetchTime = now;
    return freshData;
  } catch (error) {
    console.error('Failed to fetch fresh changelog data:', error);
    // Return cached data if available, even if stale
    return changelogCache || [];
  }
}

/**
 * Initialize changelog cache on server startup
 */
async function initializeChangelog() {
  console.log('Initializing changelog cache...');
  try {
    await getChangelogData();
    console.log('Changelog cache initialized successfully');
  } catch (error) {
    console.error('Failed to initialize changelog cache:', error);
  }
}

/**
 * Get sample/fallback changelog data
 */
function getFallbackChangelog() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  return [
    {
      date: today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      timestamp: today.getTime(),
      commits: [
        {
          message: 'Updated changelog system with server-side rendering',
          author: 'Vorel Team',
          sha: 'abc1234',
          url: 'https://github.com/1334Robotics/vorel-app',
          time: '14:30'
        }
      ]
    },
    {
      date: yesterday.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      timestamp: yesterday.getTime(),
      commits: [
        {
          message: 'Improved UI design and responsiveness',
          author: 'Vorel Team',
          sha: 'def5678',
          url: 'https://github.com/1334Robotics/vorel-app',
          time: '10:15'
        }
      ]
    }
  ];
}

module.exports = {
  initializeChangelog,
  getChangelogData,
  getFallbackChangelog
};
