# GitHub OAuth Setup Guide

This guide will help you set up GitHub OAuth authentication for the Vorel admin panel.

## 1. Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in the application details:
   - **Application name**: `Vorel Admin` (or your preferred name)
   - **Homepage URL**: `http://localhost:3002` (for development) or your production URL
   - **Authorization callback URL**: `http://localhost:3002/auth/github/callback`
4. Click "Register application"
5. Copy the **Client ID** and **Client Secret**

## 2. Configure Environment Variables

Create a `.env` file in the root directory (copy from `.env.example`) and add:

```bash
# GitHub OAuth Configuration
GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here
GITHUB_CALLBACK_URL=http://localhost:3002/auth/github/callback

# Session Secret (generate a secure random string)
SESSION_SECRET=your_very_secure_random_session_secret_here

# Authorized Users (comma-separated GitHub usernames)
AUTHORIZED_GITHUB_USERS=yourusername,teammate1,teammate2
```

## 3. Generate a Secure Session Secret

You can generate a secure session secret using Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## 4. Set Authorized Users

Add the GitHub usernames of people who should have admin access to the `AUTHORIZED_GITHUB_USERS` environment variable. Separate multiple usernames with commas.

**Important**: If this variable is empty or not set, anyone with a GitHub account can access the admin panel (useful for development, but not recommended for production).

## 5. Production Setup

For production:

1. Update the OAuth app settings in GitHub to use your production domain
2. Set `NODE_ENV=production` in your environment
3. Use a secure session secret
4. Consider using environment variable management tools or secrets management
5. Ensure HTTPS is enabled (required for secure cookies)

## 6. Testing

1. Start your server: `npm start`
2. Visit `http://localhost:3002/admin/notices`
3. You should be redirected to the login page
4. Click "Sign in with GitHub"
5. Authorize the application
6. You should be redirected back to the admin panel

## 7. Admin Panel Features

Once authenticated, you can:

- View all active notices
- Create new notices with different types (info, warning, success, danger)
- Edit existing notices
- Set notice priorities and expiration dates
- Deactivate or delete notices
- View your login status and logout

## 8. API Endpoints

The following admin API endpoints now require authentication:

- `POST /api/notices` - Create notice
- `PUT /api/notices/:id` - Update notice
- `DELETE /api/notices/:id` - Delete notice
- `POST /api/notices/:id/deactivate` - Deactivate notice

Public endpoints (no auth required):

- `GET /api/notices` - Get active notices (used by home page)

## 9. Troubleshooting

**"Missing required environment variables for GitHub OAuth"**
- Make sure you've set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in your `.env` file

**"User not authorized"**
- Check that your GitHub username is in the `AUTHORIZED_GITHUB_USERS` list
- Usernames are case-insensitive but must match exactly

**"Authentication failed"**
- Verify your OAuth app settings in GitHub
- Check that the callback URL matches exactly
- Ensure your client ID and secret are correct

**Session issues**
- Clear your browser cookies
- Check that `SESSION_SECRET` is set
- Restart the server after changing environment variables

## 10. Security Notes

- Never commit your `.env` file to version control
- Use strong, unique session secrets
- Regularly review and update authorized users
- Consider implementing additional security measures for production (rate limiting, etc.)
- Monitor authentication logs for suspicious activity
