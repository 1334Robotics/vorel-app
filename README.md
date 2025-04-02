Collecting workspace information```md
# FRC Matches Fetcher

A service to fetch alliance matches of a specific team in an event using the Blue Alliance API.

## Features

- Fetch match data from the Nexus API.
- Display team-specific match details in a full page and an embeddable widget.
- Auto-update match statuses and handle live data checks.
- Dockerized for easy deployment.

## Prerequisites

- Node.js (>=12)
- npm

## Setup

1. Clone the repository.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Create a `.env` file in the root directory using the provided [`.env.example`](.env.example) as reference:

   ```env
   Nexus_Api_Key=your_api_key_here
   PORT=3002
   ```

4. Start the application:

   ```sh
   npm start
   ```

## API Endpoints

- **GET /**  
  Renders an HTML page where users can input team and event keys to view match data.

- **GET /api/TBA-matches/test**  
  Returns raw event data for the provided `eventKey`.  
  _Example:_ `/api/TBA-matches/test?eventKey=2025miket`

- **GET /embed**  
  Provides an embeddable version of the match data.  
  _Required query parameters:_ `teamKey` and `eventKey`  
  _Optional:_ `height` (default is 600)

- **GET /api/health**  
  Health check endpoint used for Docker health checks.

- **GET /api/data-check**  
  Checks for data updates. Expects query parameters `eventKey` and `lastUpdate`.

## Docker

### Building and Running

1. Build the Docker image:

   ```sh
   docker build -t frc-matches-fetcher .
   ```

2. Run the container:

   ```sh
   docker run -d -p 3002:3002 --env NODE_ENV=production --env TBA_API_KEY=your_api_key_here frc-matches-fetcher
   ```

Alternatively, use the provided `docker-compose.yml`:

   ```sh
   docker-compose up -d
   ```

## GitHub Actions

A GitHub Actions workflow is set up in [`.github/workflows/build.yml`](.github/workflows/build.yml) to build and publish Docker images on pushes to the main branch.

## License

This project is licensed under the [GNU GENERAL PUBLIC LICENSE](LICENSE).

## Contributing

Contributions are welcome! Open issues or pull requests as needed.

## Credits

- Developed by [1334Robotics](https://github.com/1334Robotics)
- Data provided by the FIRST Nexus API
```