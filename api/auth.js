export default function handler(req, res) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "YOUR_CLIENT_ID";
  const REDIRECT_URI = process.env.REDIRECT_URI || "https://bays-inbox-manager.vercel.app/api/callback";
  const SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
  
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPE)}&access_type=offline&prompt=consent`;
  
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(200).json({ authUrl });
}


