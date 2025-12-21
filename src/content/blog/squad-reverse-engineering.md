---
title: "Solving the Impossible Squad Join Problem"
description: "How I reverse engineered EOS and Steam lobbies to fix the Squad server browser."
pubDate: 2025-12-21
heroImage: "squad-eos-hero.png"
tags: ["Reverse Engineering", "Node.js", "Squad", "Steamworks"]
---
If you play [Squad](https://store.steampowered.com/app/393380/Squad/), you know the pain. The in-game server browser has been half-broken for years. Sometimes it doesn't load, sometimes it’s slow, and for a long time, finding your favorite server was a genuine struggle.

While there have been third-party server lists for years, none of them could actually connect you to the game. They were just static displays. I wanted to fix that.

## V1: The OSINT Approach

My first idea was pretty simple: if a player is already in a server, their Steam profile usually knows about it.

I built a system where server owners installed a plugin that sent a list of steam64 IDs (of players currently in the server) to my backend. My script then iterated through those profiles until it found one that was public and had the "Join Game" button visible. I scraped the lobby link directly from their rich presence data and cached it.

All of this was done in Node.js via direct HTTP requests, no automated browsers or heavy scraping tools required. As far as I know, I was the first one to implement this, and it wasn't long before other community servers started doing the exact same thing.

It was the perfect solution, until we hit a wall: **The 0-player paradox.**

You can't scrape a lobby link from a player if there's nobody in the server. This meant my tool was useless for "seeding" servers (starting them up from empty), which is exactly when server owners need help the most.

## V2: Reverse Engineering the Network

To solve the empty server issue, I had to stop relying on existing lobbies and start creating them myself. But before I could do that, I needed to understand how Squad talks to its backend.

I fired up **Fiddler Classic**, enabled HTTPS decryption, and set it to capture traffic while the game launched.

### The Discovery
Filtering through the noise of Steam's generic analytics, I spotted a specific pattern of requests going to `api.epicgames.dev`. This confirmed that Squad uses a hybrid architecture: **Epic Online Services (EOS)** for the master server list and metadata, but **Steam** for the actual P2P connection and lobby management.

When I looked at the raw headers in Fiddler, I saw the game authenticating with a Basic Auth header. A quick base64 decode of that header revealed a Client ID and Secret that were likely hardcoded into the game build.

But the most interesting part was the payload. The game wasn't just asking for servers; it was trading credentials.

### The Handshake (Steam -> EOS)
The game performs a "token exchange." It takes a Steam Session Ticket and swaps it for an EOS Access Token. This is the key to the castle. If I wanted to query the API programmatically, I had to replicate this handshake.

I wrote a custom Node.js client to mimic this flow.

**Step 1: Get a Steam Session Ticket**
Since I can't generate a Steam ticket out of thin air, I used `steam-user` to log into the Steam network with my own account. This acts as my "passport," proving to Epic that I own a valid copy of Squad (App ID 393380).

```typescript
// Initializing a headless Steam client
const user = new SteamUser();
user.logOn({ refreshToken: process.env.STEAM_TOKEN });

// Requesting a session ticket specifically for Squad
const ticket = await user.createAuthSessionTicket(393380);
const cachedTicket = ticket.sessionTicket.toString("hex");
```

**Step 2: The Exchange**
With the ticket in hand, I construct the exact request I saw in Fiddler. I send the ticket to Epic's OAuth endpoint with the `grant_type` set to `external_auth`.

```typescript
const params = new URLSearchParams();
params.append("grant_type", "external_auth");
params.append("external_auth_type", "steam_session_ticket");
params.append("external_auth_token", cachedTicket);
// The Deployment ID found in the game's traffic URLs
params.append("deployment_id", "5dee4062a90b42cd98fcad618b6636c2"); 

const response = await axios.post(
  "https://api.epicgames.dev/auth/v1/oauth/token",
  params,
  {
    headers: {
      // The Basic Auth I found in Fiddler headers
      Authorization: "Basic " + process.env.EOS_BASIC_AUTH, 
      "User-Agent": "EOS-SDK/1.16.0-27024038 (Windows/10.0.19041.5915.64bit) Squad/1.0.0"
    }
  }
);

const eosToken = response.data.access_token;
```

### Querying the Backend
Once I had the `eosToken`, I was "in." I could now hit the matchmaking endpoints directly, bypassing the game client entirely.

I discovered that EOS uses a specific filtering logic in its JSON body. You don't just ask for "all servers"; you send criteria objects. By experimenting with the payload, I found I could query servers even if they had 0 players—data the game client usually hides or fails to connect to.

```typescript
// Asking EOS for servers, filtering by criteria
const body = {
  criteria: [
    { key: "attributes.PLAYERCOUNT_l", op: "GREATER_THAN", value: 0 },
  ],
  maxResults: 50000,
};

// The result contains the "impossible" data:
// The EOS Session ID for empty servers.
```

When I queried the raw server list, I found that even "empty" servers returned a unique **EOS Session ID**. The server existed in the backend; the game just refused to let me connect to it because it didn't have a Steam Lobby associated with it yet.

## V3: Emulating the Lobby

The hard part was figuring out how to translate that EOS Session ID into a Steam Lobby.

I couldn't use the official Steamworks Web API because I don't have a publisher key. After some digging, I found `steamworks.js`. I used it to emulate a running instance of the game and dumped the raw metadata of a valid lobby.

That’s when I found the missing link. Buried in the hex dump were specific keys that mapped the Steam lobby to the EOS session.

```javascript
// The specific metadata keys Squad needs to see
lobby.setData("buildid", "527317");
lobby.setData("CONMETHOD", "P2P");
lobby.setData("P2PPORT", "7777");
lobby.setData("NUMOPENPRIVCONN", "0");
lobby.setData("NUMOPENPUBCONN", "3");
lobby.setData("NUMPRIVCONN", "0");
lobby.setData("NUMPUBCONN", "98");
lobby.setData("OWNINGID", me.toString());
lobby.setData("OWNINGNAME", "SquadBrowser");
lobby.setData("P2PADDR", me.toString());
lobby.setData("SESSIONFLAGS", "227");

// The Bridge
lobby.setData("RedpointEOSRoomId_s", "Session:" + serverID);
lobby.setData("RedpointEOSRoomNamespace_s", "Synthetic");
```

The key was `RedpointEOSRoomId_s`. That specific value tells the game's "Redpoint" plugin which EOS session to route the traffic to.

Once I had that, I didn't need to find a lobby anymore. I just wrote a script to spin up a "fake" one using that metadata structure, injecting the target Server ID I found via my custom EOS client.

It worked instantly. Steam saw it as a valid lobby, the game read the metadata, and it connected to the empty server without complaining.

Here is the final proof-of-concept:

```javascript
const express = require('express');
const sw = require('steamworks.js');
const AsyncLock = require('async-lock');

const app = express();
const port = 3509;
const lock = new AsyncLock();
let client = null;

try {
    client = sw.init(393380);
    console.log("Steamworks initialized successfully.");
} catch (err) {
    console.error("Failed to initialize Steamworks:", err);
    process.exit(1);
}

app.use(express.json());

app.post('/create-lobby', async (req, res) => {
    const { serverID } = req.body;

    if (!serverID || !client) {
        return res.status(400).json({ error: "Invalid Request" });
    }

    try {
        const lobbyLink = await lock.acquire('steam-lobby', async () => {
            const lobby = await client.matchmaking.createLobby(2, 98);
            lobby.setJoinable(true);
            const me = client.localplayer.getSteamId().steamId64;

            // Mimicking the game's exact metadata signature
            lobby.setData("buildid", "527317");
            lobby.setData("CONMETHOD", "P2P");
            lobby.setData("P2PPORT", "7777");
            lobby.setData("NUMOPENPRIVCONN", "0");
            lobby.setData("NUMOPENPUBCONN", "3");
            lobby.setData("NUMPRIVCONN", "0");
            lobby.setData("NUMPUBCONN", "98");
            lobby.setData("OWNINGID", me.toString());
            lobby.setData("OWNINGNAME", "SquadBrowser");
            lobby.setData("P2PADDR", me.toString());
            lobby.setData("SESSIONFLAGS", "227");
            
            // Injecting the target server
            lobby.setData("RedpointEOSRoomId_s", "Session:" + serverID);
            lobby.setData("RedpointEOSRoomNamespace_s", "Synthetic");

            return `steam://joinlobby/393380/${String(lobby.id)}`;
        });
        
        res.json({ connectUrl: lobbyLink });
    } catch (error) {
        console.error('Failed to create Steam lobby:', error);
        res.status(500).json({ error: 'Failed to create Steam lobby' });
    }
});

app.listen(port, () => {
    console.log(`Steam service listening on port ${port}`);
});
```

## Conclusion

By moving from scraping (V1) to reverse engineering and protocol emulation (V2/V3), I managed to build the first external tool capable of launching a connection to an empty Squad server.

It proves that platform limitations are usually just knowledge gaps. If you can speak the API's language better than the official client does, you can build features the original developers didn't think were possible.
