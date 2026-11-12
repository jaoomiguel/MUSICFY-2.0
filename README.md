# Musicfy 2.0

Musicfy 2.0 is a full-stack music discovery and social review platform inspired by Frutiger Aero design language. The app combines a React front end with an Express + SQLite back end, enabling artist catalog management, release browsing, user reviews, social interactions, and administrator tools.

## Architecture

- Front end: React + Vite
- Back end: Node.js + Express
- Database: SQLite
- Authentication: JWT with bcrypt password hashing
- Styling: custom CSS with glassmorphism and vibrant gradients

This combination keeps the project lightweight while still providing a real persistent database, protected API routes, and a production-ready structure suitable for local deployment and further scaling.

## Features implemented

- User registration and login
- Role-based access control with ADMIN and USER roles
- Artist and release catalog
- Tracklists and media links
- Review publishing and rating system
- Like system for reviews
- Artist detail pages and release detail pages
- Social feed with recent community reviews
- User profile page
- Playlist and favorites support
- Pre-save flow and notification model
- Admin dashboard for creating artists and releases
- Responsive Frutiger Aero UI

## Local setup

1. Install dependencies:

   npm install

2. Create a local environment file:

   copy .env.example .env

3. Start the application:

   npm run dev

This runs both the API and the front-end dev server.

- Front end: http://localhost:5173
- API: http://localhost:4000

## Admin credentials

- Username: admin
- Password: Admin123!

## Database notes

The SQLite database is created automatically on first API start at `server/data/musicfy.db`. The seed script populates the base roles, sample artists, sample releases, and demo users.

## Build for production

npm run build

To serve the built static front end with the API in production mode:

NODE_ENV=production npm run start

## Project structure

- `server/index.js` — Express API, database bootstrap and endpoints
- `src/App.jsx` — React pages and UI logic
- `src/styles.css` — full visual styling
- `index.html` — Vite entry point
- `vite.config.js` — Vite configuration and API proxy

## Main API routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/artists`
- `GET /api/artists/:id`
- `GET /api/releases`
- `GET /api/releases/:id`
- `POST /api/reviews`
- `POST /api/reviews/:id/like`
- `GET /api/profile/:userId`
- `GET /api/explore`
- `GET /api/dashboard` (admin only)

## Notes

This project is built as a functional MVP aligned with the requested product brief. It prioritizes real persistence, secure API handling, and working feature flows over a static mockup.
