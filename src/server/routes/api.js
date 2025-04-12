const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchEventMatchResults, searchTBAEvents } = require('../helpers/api');
const { extractRPRelevantData } = require('../helpers/matches');
const crypto = require('crypto');

// Health endpoint for Docker healthchecks
router.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Data-check endpoint to detect changes
router.get("/data-check", async (req, res) => {
  let { eventKey: rawEventKey, teamKey, lastUpdate } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;

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
