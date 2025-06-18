-- Initialize Vorel database schema
-- Note: Database 'vorel' is already created by docker-compose environment variables
SELECT 'Starting Vorel database initialization...' as message;
USE vorel;

-- Events table for FRC events
CREATE TABLE IF NOT EXISTS events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(50) UNIQUE NOT NULL,
    year INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(100),
    state_prov VARCHAR(50),
    country VARCHAR(50) DEFAULT 'USA',
    start_date DATE,
    end_date DATE,
    week INT,
    event_type VARCHAR(50),
    -- Store original TBA data as JSON for flexibility
    raw_data JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes for fast searching
    INDEX idx_year (year),
    INDEX idx_name (name),
    INDEX idx_location (city, state_prov),
    INDEX idx_event_key (event_key),
    INDEX idx_date_range (start_date, end_date),
    INDEX idx_year_date (year, start_date),
    
    -- Full-text search index for comprehensive text search
    FULLTEXT(name, city, state_prov, event_key)
);

-- Create a view for formatted search results
CREATE OR REPLACE VIEW event_search_view AS
SELECT 
    event_key as `key`,
    CONCAT(year, ' ', name) as name,
    CASE 
        WHEN city IS NOT NULL AND state_prov IS NOT NULL THEN CONCAT(city, ', ', state_prov)
        WHEN city IS NOT NULL THEN city
        WHEN state_prov IS NOT NULL THEN state_prov
        ELSE country
    END as location,
    CASE 
        WHEN start_date = end_date THEN DATE_FORMAT(start_date, '%b %e, %Y')
        ELSE CONCAT(DATE_FORMAT(start_date, '%b %e'), ' - ', DATE_FORMAT(end_date, '%b %e, %Y'))
    END as date,
    year,
    start_date,
    end_date
FROM events
WHERE year >= 2025
ORDER BY year DESC, start_date;

-- Insert some sample data for testing (optional)
-- This will be replaced by the migration script

SELECT 'Vorel database initialization completed successfully!' as message;
