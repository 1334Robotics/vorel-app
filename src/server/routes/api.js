const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchEventMatchResults, searchTBAEvents } = require('../helpers/api');
const { extractRPRelevantData } = require('../helpers/matches');
const crypto = require('crypto');

// SSE connections store with data hashes
const sseConnections = new Map();
const lastDataHashes = new Map();

// Add debug logging to SSE endpoints
console.log('SSE routes loaded');

// Health endpoint for Docker healthchecks
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now(), uptime: process.uptime() });
});

// Endpoint to check active SSE connections 
router.get('/sse-stats', (req, res) => {
  const totalConnections = sseConnections.size;
  const connectionsByEvent = {};
  
  for (const [connectionId, connection] of sseConnections.entries()) {
    const key = `${connection.eventKey}-${connection.teamKey}`;
    if (!connectionsByEvent[key]) {
      connectionsByEvent[key] = {
        count: 0,
        oldestConnection: connection.connectedAt
      };
    }
    connectionsByEvent[key].count++;
    connectionsByEvent[key].oldestConnection = Math.min(
      connectionsByEvent[key].oldestConnection, 
      connection.connectedAt
    );
  }
  
  res.json({
    totalConnections,
    connectionsByEvent,
    timestamp: Date.now()
  });
});

// SSE endpoint for real-time updates
router.get('/updates-stream', async (req, res) => {
  const { eventKey: rawEventKey, teamKey } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;

  if (!teamKey || !eventKey) {
    return res.status(400).json({ error: "Missing eventKey or teamKey" });
  }

  // Create unique connection ID per user session using random UUID
  const sessionId = crypto.randomUUID();
  const connectionId = `${eventKey}-${teamKey}-${sessionId}`;
  console.log(`Establishing SSE connection: ${connectionId}`);
  // Set SSE headers optimized for Cloudflare
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
    'CF-Cache-Status': 'BYPASS' // Tell Cloudflare not to cache SSE responses
  });
  
  // Set shorter timeouts to work with Cloudflare's 100-second limit
  req.setTimeout(90000); // 90 seconds - less than Cloudflare's timeout
  res.setTimeout(90000); // 90 seconds - less than Cloudflare's timeout  // Send initial connection confirmation with current hash
  try {
    const currentHash = await getDataHash(eventKey, teamKey);
    const initialMessage = JSON.stringify({ 
      type: 'connected', 
      timestamp: Date.now(),
      hash: currentHash 
    });
    res.write(`data: ${initialMessage}\n\n`);
    console.log(`SSE connection confirmed for ${connectionId}`);
  } catch (error) {
    console.error('Error getting initial hash for SSE:', error);    // If hash fails, send connection without hash
    const fallbackMessage = JSON.stringify({ type: 'connected', timestamp: Date.now() });
    res.write(`data: ${fallbackMessage}\n\n`);
    console.log(`SSE connection confirmed (fallback) for ${connectionId}`);
  }
    // Store connection
  sseConnections.set(connectionId, { res, eventKey, teamKey, connectedAt: Date.now() });
  
    // Handle client disconnect
  req.on('close', () => {
    const connection = sseConnections.get(connectionId);
    sseConnections.delete(connectionId);
    lastDataHashes.delete(connectionId);
    clearInterval(keepAlive);
    clearTimeout(autoReconnectTimer);
    
    // Log remaining connections for this event+team
    if (connection) {
      const remainingConnections = Array.from(sseConnections.entries())
        .filter(([id, conn]) => conn.eventKey === connection.eventKey && conn.teamKey === connection.teamKey);
      console.log(`Remaining SSE connections for ${connection.eventKey}-${connection.teamKey}: ${remainingConnections.length}`);
    }
  });// Handle connection errors (ignore aborts from tab closing)
  req.on('error', (error) => {
    // Ignore abort errors - these happen when user closes tab/navigates away
    if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || error.message.includes('aborted')) {
      console.log(`SSE connection naturally closed: ${connectionId}`);
    } else {
      console.error(`SSE connection error for ${connectionId}:`, error);
    }
    sseConnections.delete(connectionId);
    lastDataHashes.delete(connectionId);
    clearInterval(keepAlive);
    clearTimeout(autoReconnectTimer);
  });

  res.on('error', (error) => {
    // Ignore abort errors - these happen when user closes tab/navigates away
    if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || error.message.includes('aborted')) {
      console.log(`SSE response naturally closed: ${connectionId}`);
    } else {
      console.error(`SSE response error for ${connectionId}:`, error);
    }
    sseConnections.delete(connectionId);
    lastDataHashes.delete(connectionId);
    clearInterval(keepAlive);
    clearTimeout(autoReconnectTimer);
  });// Keep connection alive with Cloudflare-friendly heartbeats
  const keepAlive = setInterval(async () => {
    if (sseConnections.has(connectionId)) {
      try {
        // Get current hash for heartbeat
        const currentHash = await getDataHash(eventKey, teamKey);
        res.write(`data: ${JSON.stringify({ 
          type: 'heartbeat', 
          timestamp: Date.now(),
          hash: currentHash 
        })}\n\n`);
      } catch (error) {
        console.error('Error in SSE heartbeat:', error);
        // If hash fails, send heartbeat without hash
        try {
          res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
        } catch (writeError) {
          // Ignore write errors from aborted connections (tab closing)
          if (writeError.code === 'ECONNABORTED' || writeError.code === 'ECONNRESET' || 
              writeError.message.includes('aborted') || writeError.message.includes('closed')) {
            console.log(`SSE heartbeat connection naturally closed: ${connectionId}`);
          } else {
            console.error('Error writing heartbeat:', writeError);
          }
          // Connection is broken, clean up
          sseConnections.delete(connectionId);
          clearInterval(keepAlive);
        }
      }
    } else {
      clearInterval(keepAlive);
    }
  }, 10000); // Send heartbeat every 10 seconds to stay well under Cloudflare's timeout
  
  // Auto-close connection before Cloudflare timeout to allow clean reconnection
  const autoReconnectTimer = setTimeout(() => {
    if (sseConnections.has(connectionId)) {
      console.log(`Auto-closing SSE connection before Cloudflare timeout: ${connectionId}`);
      try {
        // Send a reconnect signal before closing
        res.write(`data: ${JSON.stringify({ 
          type: 'reconnect', 
          reason: 'timeout_prevention',
          timestamp: Date.now() 
        })}\n\n`);
        // Close connection gracefully
        res.end();
      } catch (error) {
        console.log('Error during auto-close:', error);
      }
      sseConnections.delete(connectionId);
      lastDataHashes.delete(connectionId);
      clearInterval(keepAlive);
    }
  }, 85000); // Close after 85 seconds, before Cloudflare's 100-second timeout
  
  // Clean up timers when connection closes
  req.on('close', () => {
    clearInterval(keepAlive);
    clearTimeout(autoReconnectTimer);
  });
});

// Function to check for updates and notify SSE clients
async function checkAndNotifyUpdates() {
  const connectionsToCheck = Array.from(sseConnections.entries());
  
  for (const [connectionId, connection] of connectionsToCheck) {
    try {
      const { res, eventKey, teamKey } = connection;
        // Check if connection is stale (older than 5 minutes without activity for Cloudflare)
      const connectionAge = Date.now() - connection.connectedAt;
      if (connectionAge > 300000) { // 5 minutes (reduced for Cloudflare)
        console.log(`Removing stale SSE connection: ${connectionId}`);
        sseConnections.delete(connectionId);
        lastDataHashes.delete(connectionId);
        try {
          res.end();
        } catch (e) {
          // Ignore errors when closing stale connections
        }
        continue;
      }
      
      // Get current data hash
      const currentHash = await getDataHash(eventKey, teamKey);
      const lastHash = lastDataHashes.get(connectionId);
      
      // Only send update if data has actually changed
      if (currentHash && currentHash !== lastHash) {
        lastDataHashes.set(connectionId, currentHash);
        
        try {
          res.write(`data: ${JSON.stringify({ 
            type: 'update', 
            hash: currentHash,
            timestamp: Date.now() 
          })}\n\n`);
        } catch (writeError) {
          // Ignore write errors from aborted connections (tab closing)
          if (writeError.code === 'ECONNABORTED' || writeError.code === 'ECONNRESET' || 
              writeError.message.includes('aborted') || writeError.message.includes('closed')) {
            console.log(`SSE update connection naturally closed: ${connectionId}`);
          } else {
            console.error(`Error writing update to ${connectionId}:`, writeError);
          }
          // Remove the failed connection
          sseConnections.delete(connectionId);
          lastDataHashes.delete(connectionId);
          continue;
        }
      }
    } catch (error) {
      // Ignore errors from aborted connections (tab closing)
      if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || 
          error.message.includes('aborted') || error.message.includes('closed')) {
        console.log(`SSE update check connection naturally closed: ${connectionId}`);
      } else {
        console.error(`Error checking updates for ${connectionId}:`, error);
      }
      // Remove failed connection
      sseConnections.delete(connectionId);
      lastDataHashes.delete(connectionId);
    }
  }
}

// Helper function to get data hash (same logic as data-check endpoint)
async function getDataHash(eventKey, teamKey) {
  try {
    // Use the same logic as /api/current-matches to get processed data
    const frcTeamKey = teamKey.startsWith("frc") ? teamKey : `frc${teamKey}`;
    
    // Fetch Nexus data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return null;
    }

    // Get team ranking from TBA
    let teamRankingData = null;
    if (teamKey) {
      const teamStatus = await fetchTeamStatusAtEvent(frcTeamKey, eventKey);
      if (teamStatus && teamStatus.qual && teamStatus.qual.ranking) {
        teamRankingData = teamStatus.qual.ranking;
      }
    }    // Process the data with TBA results (same as current-matches endpoint)
    const { processMatchDataWithTBAResults } = require('../helpers/matches');
    
    // Apply same filtering logic as current-matches endpoint
    const formattedTeamKey = teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey;
    
    // Sort matches by their sequence
    let matches = [...eventData.matches];
    matches.sort((a, b) => {
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      
      if (aType !== bType) return aType.localeCompare(bType);
      
      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });
    
    // Auto-complete logic
    for (let i = 0; i < matches.length - 1; i++) {
      if (matches[i].status === "On field") {
        for (let j = i + 1; j < matches.length; j++) {
          if (matches[j].status === "On field") {
            matches[i].status = "Completed";
            break;
          }
        }
      }
    }
    
    // Filter matches for the requested team
    const teamMatches = matches.filter(match => 
      Array.isArray(match.redTeams) && match.redTeams.includes(formattedTeamKey) || 
      Array.isArray(match.blueTeams) && match.blueTeams.includes(formattedTeamKey)
    );
    
    const processedData = await processMatchDataWithTBAResults(
      teamMatches,
      frcTeamKey,
      eventKey
    );

    // Create a hash from the processed data structure (matching current-matches response)
    const dataObj = {
      nowQueuing: eventData.nowQueuing,
      matches: processedData.matches.map(match => ({
        id: match.label.replace(/\s+/g, "-"),
        status: match.status,
        result: match.result || null,
        score: match.score || null,
        rankingPoints: match.rankingPoints || null
      })),
      completedMatches: processedData.completedMatches.map(match => ({
        id: match.label.replace(/\s+/g, "-"),
        status: match.status,
        result: match.result || null,
        score: match.score || null,
        rankingPoints: match.rankingPoints || null
      })),
      teamRanking: teamRankingData ? {
        rank: teamRankingData.rank,
        record: `${teamRankingData.record.wins}-${teamRankingData.record.losses}-${teamRankingData.record.ties}`,
        matchesPlayed: teamRankingData.matches_played
      } : null
    };

    return crypto.createHash('md5').update(JSON.stringify(dataObj)).digest('hex');
  } catch (error) {
    console.error('Error creating data hash:', error);
    return null;
  }
}

// Start periodic update checks for SSE clients
setInterval(checkAndNotifyUpdates, 5000); // Check every 5 seconds

// Data-check endpoint to detect changes
router.get("/data-check", async (req, res) => {
  let { eventKey: rawEventKey, teamKey, lastUpdate } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;

    if (!teamKey || !eventKey) {
    return res.status(400).json({ error: "Missing eventKey or teamKey" });
  }

  try {
    // Fetch Nexus data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Fetch TBA data if teamKey is provided
    let tbaMatchData = [];
    let teamRankingData = null;
    if (teamKey) {
      // Format team key for TBA
      const formattedTeamKey = teamKey.startsWith("frc")
        ? teamKey
        : `frc${teamKey}`;

      // Get TBA match results
      tbaMatchData = await fetchEventMatchResults(eventKey);

      // Get team ranking from TBA
      const teamStatus = await fetchTeamStatusAtEvent(
        formattedTeamKey,
        eventKey
      );
      if (teamStatus && teamStatus.qual && teamStatus.qual.ranking) {
        teamRankingData = teamStatus.qual.ranking;
      }
    }

    // Create a copy of matches for modification
    const modifiedMatches = [...eventData.matches];

    // Sort matches by their sequence
    modifiedMatches.sort((a, b) => {
      const aType = a.label.split(" ")[0];
      const bType = b.label.split(" ")[0];
      if (aType !== bType) return aType.localeCompare(bType);

      const aNum = parseInt(a.label.split(" ")[1]);
      const bNum = parseInt(b.label.split(" ")[1]);
      return aNum - bNum;
    });

    // Mark earlier matches as completed if a later match is "On field"
    for (let i = 0; i < modifiedMatches.length - 1; i++) {
      if (modifiedMatches[i].status === "On field") {
        for (let j = i + 1; j < modifiedMatches.length; j++) {
          if (modifiedMatches[j].status === "On field") {
            modifiedMatches[i].status = "Completed";
            break;
          }
        }
      }
    }

    // Create a hash that includes both Nexus and TBA data
    const dataObj = {
      // Nexus data
      nowQueuing: eventData.nowQueuing || null,
      matchStatuses: modifiedMatches
        .map((m) => ({
          id: m.label.replace(/\s+/g, "-"),
          status: m.status.trim(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),

      // TBA data with more complete match details
      tbaMatches: tbaMatchData.map((m) => ({
        key: m.key,
        comp_level: m.comp_level,
        match_number: m.match_number,
        alliances: m.alliances
          ? {
              red: { score: m.alliances.red.score },
              blue: { score: m.alliances.blue.score },
            }
          : null,
        winning_alliance: m.winning_alliance,
        // Include actual score breakdown data for RP calculations
        score_breakdown: m.score_breakdown
          ? {
              red: extractRPRelevantData(m.score_breakdown.red),
              blue: extractRPRelevantData(m.score_breakdown.blue),
            }
          : null,
      })),

      // Team ranking data
      ranking: teamRankingData
        ? {
            rank: teamRankingData.rank,
            matches_played: teamRankingData.matches_played,
            sort_orders: teamRankingData.sort_orders,
            extra_stats: teamRankingData.extra_stats,
            wins: teamRankingData.record.wins,
            losses: teamRankingData.record.losses,
            ties: teamRankingData.record.ties,
          }
        : null,
    };

    const dataHash = JSON.stringify(dataObj);

    const currentHash = crypto.createHash("md5").update(dataHash).digest("hex");

    // If lastUpdate is empty, assume it's the initial load and don't trigger a refresh
    if (!lastUpdate) {
      lastUpdate = currentHash;
    }

    const hasChanged = lastUpdate !== currentHash;

    res.json({
      changed: hasChanged,
      hash: currentHash,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Error checking for updates:", error);
    res.status(500).json({ error: "Failed to check for updates" });
  }
});

// SSE endpoint to get current match data for updates
router.get('/current-matches', async (req, res) => {
  const { eventKey: rawEventKey, teamKey } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;

  if (!teamKey || !eventKey) {
    return res.status(400).json({ error: "Missing eventKey or teamKey" });
  }

  try {
    const formattedTeamKey = teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey;
    
    // Fetch Nexus data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Fetch TBA data
    let tbaMatchData = [];
    let teamRankingData = null;
    const frcTeamKey = `frc${formattedTeamKey}`;

    try {
      tbaMatchData = await fetchEventMatchResults(eventKey);
      const teamStatus = await fetchTeamStatusAtEvent(frcTeamKey, eventKey);
      if (teamStatus && teamStatus.qual && teamStatus.qual.ranking) {
        teamRankingData = teamStatus.qual.ranking;
      }
    } catch (tbaError) {
      console.log('TBA data fetch failed:', tbaError.message);    }    // Process the data similar to the main route
    const { processMatchDataWithTBAResults } = require('../helpers/matches');
    
    // Sort matches by their sequence (same as main route)
    let matches = [...eventData.matches]; // Create a copy we can modify
    matches.sort((a, b) => {
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      
      if (aType !== bType) return aType.localeCompare(bType);
      
      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });
    
    // Auto-complete logic: mark earlier "On field" match as "Completed" if a later one is "On field"
    for (let i = 0; i < matches.length - 1; i++) {
      if (matches[i].status === "On field") {
        for (let j = i + 1; j < matches.length; j++) {
          if (matches[j].status === "On field") {
            matches[i].status = "Completed";
            break;
          }
        }
      }
    }
    
    // Filter matches for the requested team (same as main route)
    const teamMatches = matches.filter(match => 
      Array.isArray(match.redTeams) && match.redTeams.includes(formattedTeamKey) || 
      Array.isArray(match.blueTeams) && match.blueTeams.includes(formattedTeamKey)
    );
    
    const processedData = await processMatchDataWithTBAResults(
      teamMatches,
      frcTeamKey,
      eventKey
    );

    res.json({
      nowQueuing: eventData.nowQueuing,
      matches: processedData.matches,
      completedMatches: processedData.completedMatches,
      matchGroups: processedData.matchGroups,
      teamRanking: teamRankingData ? {
        rank: teamRankingData.rank,
        record: `${teamRankingData.record.wins}-${teamRankingData.record.losses}-${teamRankingData.record.ties}`,
        matchesPlayed: teamRankingData.matches_played,
        matches: teamRankingData.matches_played
      } : null
    });
  } catch (error) {
    console.error("Error fetching current matches:", error);
    res.status(500).json({ error: "Failed to fetch current matches" });
  }
});

// Event search endpoint
router.get("/events/search", async (req, res) => {
  try {
    const query = req.query.q || "";

    if (query.length < 3) {
      return res.json([]);
    }

    // Get current year
    const currentYear = new Date().getFullYear();

    // Search events from current and next year
    const [currentYearEvents] = await Promise.all([
      searchTBAEvents(query, currentYear)
    ]);

    // Combine and limit results
    const combinedEvents = [...currentYearEvents];

    // Return top 10 results
    res.json(combinedEvents.slice(0, 10));
  } catch (error) {
    console.error("Error searching events:", error);
    res.status(500).json({ error: "Failed to search events" });
  }
});

module.exports = router;
