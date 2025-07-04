const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchEventMatchResults, searchTBAEventsEnhanced, getTeamEventsWithCache } = require('../helpers/api');
const { extractRPRelevantData } = require('../helpers/matches');
const { requireAuthAPI } = require('../helpers/auth');
const crypto = require('crypto');

// SSE connections store with data hashes
const sseConnections = new Map();
const lastDataHashes = new Map();

// Webhook statistics tracking
const webhookStats = {
  totalReceived: 0,
  lastReceived: null,
  eventsReceived: new Map(), // eventKey -> count
  connectionsTriggered: 0,
  lastProcessingTime: 0
};

// Add debug logging to SSE endpoints
console.log('SSE routes loaded');

// Health endpoint for Docker healthchecks
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now(), uptime: process.uptime(), readme: 'Why are you Here?' });
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

// Webhook statistics endpoint
router.get('/webhook-stats', (req, res) => {
  res.json({
    totalReceived: webhookStats.totalReceived,
    lastReceived: webhookStats.lastReceived ? new Date(webhookStats.lastReceived).toISOString() : null,
    eventsReceived: Object.fromEntries(webhookStats.eventsReceived),
    connectionsTriggered: webhookStats.connectionsTriggered,
    lastProcessingTime: webhookStats.lastProcessingTime,
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

// Webhook endpoint for FRC Nexus real-time notifications
router.post('/webhook/nexus', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Update webhook statistics
    webhookStats.totalReceived++;
    webhookStats.lastReceived = startTime;
    
    // Verify the webhook token from Nexus-Token header
    const nexusToken = req.headers['nexus-token'];
    const expectedToken = process.env.NEXUS_WEBHOOK_TOKEN;
    
    if (expectedToken) {
      if (!nexusToken || nexusToken !== expectedToken) {
        console.warn('Invalid or missing Nexus-Token header from IP:', req.ip);
        console.warn('Expected:', expectedToken);
        console.warn('Received:', nexusToken || 'undefined');
        return res.status(401).json({ error: 'Invalid or missing Nexus-Token header' });
      }
      console.log('Webhook token verified successfully');
    } else {
      console.warn('⚠️ NEXUS_WEBHOOK_TOKEN not configured - webhook verification disabled');
    }

    // Check if this is just a validation request (empty body or only token)
    if (!req.body || Object.keys(req.body).length === 0 || (req.body.token && !req.body.eventKey)) {
      console.log('🔍 Received FRC Nexus webhook validation/test request');
      return res.status(200).json({ 
        status: 'validated',
        message: 'Webhook endpoint ready for FRC Nexus',
        timestamp: Date.now()
      });
    }

    const { eventKey, dataAsOfTime, match, nowQueuing, matches } = req.body;
    
    if (!eventKey) {
      console.error('Webhook payload missing eventKey. Received payload:', JSON.stringify(req.body, null, 2));
      console.error('Expected FRC Nexus webhook format with eventKey, dataAsOfTime, etc.');
      return res.status(400).json({ 
        error: 'Missing eventKey in webhook payload',
        received: req.body,
        expected: 'FRC Nexus webhook format with eventKey field'
      });
    }

    // Normalize eventKey to lowercase for consistent matching
    const normalizedEventKey = eventKey.toLowerCase();

    // Track events received
    const currentCount = webhookStats.eventsReceived.get(normalizedEventKey) || 0;
    webhookStats.eventsReceived.set(normalizedEventKey, currentCount + 1);

    console.log(`Received Nexus webhook for event: ${eventKey} at ${new Date(dataAsOfTime).toISOString()}`);
    
    // Log additional payload details for debugging
    if (match) {
      console.log(`Match update: ${match.label} - ${match.status}`);
      if (match.redTeams && match.blueTeams) {
        console.log(`Red: ${match.redTeams.join(', ')} vs Blue: ${match.blueTeams.join(', ')}`);
      }
    }
    if (nowQueuing !== undefined) {
      console.log(`Now queuing: ${nowQueuing || 'None'}`);
    }
    if (matches && Array.isArray(matches)) {
      console.log(`Total matches in payload: ${matches.length}`);
    }

    // Check if we have any active SSE connections watching this event
    const watchedConnections = [];
    for (const [connectionId, connection] of sseConnections.entries()) {
      if (connection.eventKey === normalizedEventKey) {
        watchedConnections.push({ connectionId, connection });
      }
    }

    if (watchedConnections.length > 0) {
      console.log(`Found ${watchedConnections.length} active connections watching event ${eventKey} - triggering instant update`);
      
      // Trigger immediate update for all connections watching this event
      let successfulUpdates = 0;
      const updatePromises = watchedConnections.map(async ({ connectionId, connection }) => {
        try {
          const { res, eventKey: connEventKey, teamKey } = connection;
          
          // Get current data hash
          const currentHash = await getDataHash(connEventKey, teamKey);
          const lastHash = lastDataHashes.get(connectionId);
          
          // Only send update if data has actually changed
          if (currentHash && currentHash !== lastHash) {
            lastDataHashes.set(connectionId, currentHash);
            
            try {
              res.write(`data: ${JSON.stringify({ 
                type: 'update', 
                hash: currentHash,
                timestamp: Date.now(),
                source: 'webhook' // Indicate this update came from webhook
              })}\n\n`);
              console.log(`Sent webhook-triggered update to connection: ${connectionId}`);
              return true; // Success
            } catch (writeError) {
              // Handle connection errors
              if (writeError.code === 'ECONNABORTED' || writeError.code === 'ECONNRESET' || 
                  writeError.message.includes('aborted') || writeError.message.includes('closed')) {
                console.log(`🔌 Webhook update connection naturally closed: ${connectionId}`);
              } else {
                console.error(`❌ Error writing webhook update to ${connectionId}:`, writeError);
              }
              // Remove the failed connection
              sseConnections.delete(connectionId);
              lastDataHashes.delete(connectionId);
              return false;
            }
          } else {
            console.log(`🔄 No data change detected for connection ${connectionId} - skipping update`);
            return false;
          }
        } catch (error) {
          console.error(`❌ Error processing webhook update for connection ${connectionId}:`, error);
          // Remove failed connection
          sseConnections.delete(connectionId);
          lastDataHashes.delete(connectionId);
          return false;
        }
      });
      
      // Wait for all updates to complete
      const results = await Promise.all(updatePromises);
      successfulUpdates = results.filter(Boolean).length;
      
      webhookStats.connectionsTriggered += successfulUpdates;
      
      if (successfulUpdates > 0) {
        console.log(`🎯 Successfully triggered ${successfulUpdates}/${watchedConnections.length} connections`);
      }
    } else {
      console.log(`👀 No active connections watching event ${eventKey} - webhook acknowledged but not processed`);
    }

    // Record processing time
    webhookStats.lastProcessingTime = Date.now() - startTime;

    // Return success response
    res.status(200).json({ 
      status: 'received', 
      eventKey: normalizedEventKey,
      connectionsNotified: watchedConnections.length,
      processingTime: webhookStats.lastProcessingTime,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('💥 Error processing Nexus webhook:', error);
    webhookStats.lastProcessingTime = Date.now() - startTime;
    res.status(500).json({ 
      error: 'Internal server error processing webhook',
      processingTime: webhookStats.lastProcessingTime
    });
  }
});

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
    }    // Get current year
    const currentYear = new Date().getFullYear();

    // Search events using enhanced search (MariaDB + cache fallback)
    const searchResults = await searchTBAEventsEnhanced(query, currentYear);

    // Return results (already limited by the enhanced search function)
    res.json(searchResults);
  } catch (error) {
    console.error("Error searching events:", error);
    res.status(500).json({ error: "Failed to search events" });
  }
});

// Team events endpoint - returns events for a specific team, prioritized by date
router.get("/team-events", async (req, res) => {
  try {
    const { teamKey } = req.query;

    if (!teamKey) {
      return res.status(400).json({ error: "Missing teamKey parameter" });
    }    // Remove 'frc' prefix if present for consistent handling
    const numericTeamKey = teamKey.replace(/^frc/i, '');
    
    // Validate team key format (should be numeric, allow single digits)
    if (!/^\d{1,5}$/.test(numericTeamKey)) {
      return res.status(400).json({ error: "Invalid team key format" });
    }    const currentYear = new Date().getFullYear();
    
    // Only get events for current year (for auto-suggestions)
    const currentYearEvents = await getTeamEventsWithCache(numericTeamKey, currentYear);
    
    // Return the prioritized events (no need to check next year for auto-suggestions)
    res.json(currentYearEvents);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch team events" });
  }
});

// Database status endpoint
router.get('/db-status', async (req, res) => {
  try {
    const { getDBStats, testConnection } = require('../helpers/database');
    
    const [connected, stats] = await Promise.all([
      testConnection(),
      getDBStats().catch(() => null)
    ]);
    
    res.json({
      connected,
      stats,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error getting database status:', error);
    res.status(500).json({ 
      error: 'Failed to get database status',
      connected: false 
    });
  }
});

// Notice Management API Endpoints

// GET all active notices (for public display)
router.get('/notices', async (req, res) => {
  try {
    const { getActiveNotices } = require('../helpers/database');
    const notices = await getActiveNotices();
    res.json(notices);
  } catch (error) {
    console.error('Error fetching notices:', error);
    res.status(500).json({ error: 'Failed to fetch notices' });
  }
});

// POST create a new notice (admin endpoint - requires auth)
router.post('/notices', requireAuthAPI, async (req, res) => {
  try {
    const { createNotice } = require('../helpers/database');
    const { title, content, type, is_active, priority, starts_at, expires_at } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    
    const noticeData = {
      title,
      content,
      type: type || 'info',
      is_active: is_active !== undefined ? is_active : true,
      priority: priority || 0,
      starts_at: starts_at || null,
      expires_at: expires_at || null
    };
    
    const noticeId = await createNotice(noticeData);
    console.log(`Notice created by ${req.user.username}: "${title}"`);
    res.status(201).json({ id: Number(noticeId), message: 'Notice created successfully' });
  } catch (error) {
    console.error('Error creating notice:', error);
    res.status(500).json({ error: 'Failed to create notice' });
  }
});

// PUT update an existing notice (admin endpoint - requires auth)
router.put('/notices/:id', requireAuthAPI, async (req, res) => {
  try {
    const { updateNotice } = require('../helpers/database');
    const { id } = req.params;
    const { title, content, type, is_active, priority, starts_at, expires_at } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    
    const noticeData = {
      title,
      content,
      type: type || 'info',
      is_active: is_active !== undefined ? is_active : true,
      priority: priority || 0,
      starts_at: starts_at || null,
      expires_at: expires_at || null
    };
    
    const updated = await updateNotice(id, noticeData);
    if (updated) {
      console.log(`Notice ${id} updated by ${req.user.username}: "${title}"`);
      res.json({ message: 'Notice updated successfully' });
    } else {
      res.status(404).json({ error: 'Notice not found' });
    }
  } catch (error) {
    console.error('Error updating notice:', error);
    res.status(500).json({ error: 'Failed to update notice' });
  }
});

// DELETE a notice (admin endpoint - requires auth)
router.delete('/notices/:id', requireAuthAPI, async (req, res) => {
  try {
    const { deleteNotice } = require('../helpers/database');
    const { id } = req.params;
    
    const deleted = await deleteNotice(id);
    if (deleted) {
      console.log(`Notice ${id} deleted by ${req.user.username}`);
      res.json({ message: 'Notice deleted successfully' });
    } else {
      res.status(404).json({ error: 'Notice not found' });
    }
  } catch (error) {
    console.error('Error deleting notice:', error);
    res.status(500).json({ error: 'Failed to delete notice' });
  }
});

// POST deactivate a notice (soft delete - requires auth)
router.post('/notices/:id/deactivate', requireAuthAPI, async (req, res) => {
  try {
    const { deactivateNotice } = require('../helpers/database');
    const { id } = req.params;
    
    const deactivated = await deactivateNotice(id);
    if (deactivated) {
      console.log(`Notice ${id} deactivated by ${req.user.username}`);
      res.json({ message: 'Notice deactivated successfully' });
    } else {
      res.status(404).json({ error: 'Notice not found' });
    }
  } catch (error) {
    console.error('Error deactivating notice:', error);
    res.status(500).json({ error: 'Failed to deactivate notice' });
  }
});

module.exports = router;
