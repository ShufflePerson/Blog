---
title: "Bypassing Squad's Broken Browser"
description: "The in-game browser is hot garbage. I reversed the EOS API to build a zero-latency tracker that sees everything—even the lobbies that lag the game out."
pubDate: 2025-12-26
heroImage: "squad-api-hero.png"
socialImage: "./squad-api-small.png"
tags: ["Reverse Engineering", "Node.js", "Squad", "EOS", "Networking"]
---

Let's be honest: the Squad server browser sucks. It takes forever to load, the refresh button is a placebo half the time, and specific servers just ghost you even when you *know* they're up.

It’s frustrating because the data is there. The game isn't intentionally hiding it; the UI is just choking on thousands of UDP packets while trying to render a 3D background. I got sick of waiting, so I decided to bypass the UI entirely and talk directly to the Master Server.

Here is how I reversed the Epic Online Services (EOS) API to build a zero-latency tracker that sees everything—even the "FireTeam" lobbies that usually make the menu freeze.

### Pretending to be Steam

You can't just ask for the server list anonymously. You need a valid session. I spent a while trying to see if I could replay an old token, but they expire pretty fast. To talk to the EOS backend, you effectively have to emulate a running Steam Client.

The game uses a "Steam Session Ticket" to prove you own the game. I used the `steam-user` library to run a headless Steam instance inside my Node app. It logs in, convinces Valve that I'm running Squad (AppID 393380), and grabs a cryptographically signed ticket.

```typescript
async function _getEosAuthInternal(): Promise<IEOSAuthResponse> {
    const user = await getSteamUser();
    // We need a real ticket signed by Valve or EOS ignores us
    const ticket = await user.createAuthSessionTicket(393380);
    const cachedTicket = ticket.sessionTicket.toString("hex");

    const params = new URLSearchParams();
    params.append("grant_type", "external_auth");
    params.append("external_auth_type", "steam_session_ticket");
    params.append("external_auth_token", cachedTicket);
    // Hardcoded deployment ID for Squad found in Fiddler logs
    params.append("deployment_id", "5dee4062a90b42cd98fcad618b6636c2");
    
    // ... post request ...
}
```

The game then trades this Steam ticket for an EOS Access Token. This token is the golden key.

### Filtering the Noise (The Query Logic)

The reason the in-game browser lags is mostly client-side processing. The API itself is actually incredibly snappy if you query it right.

The endpoint `matchmaking/v1/.../filter` uses a "Criteria" system. Instead of asking for everything and filtering it locally (like the game does), I can tell the server exactly what I want.

For example, asking for servers that actually have players:

```typescript
const body = {
    criteria: [
        // Don't waste bandwidth on empty servers
        { key: "attributes.PLAYERCOUNT_l", op: "GREATER_THAN", value: 0 },
        // Ignore local/co-op instances
        { key: "attributes.COOPSERVER_b", op: "EQUAL", value: false },
    ],
    maxResults: 50000,
};
```

This returns a JSON array of every populated server in milliseconds. No UI lag, no missing entries.

### Hunting for FireTeams

Squad recently added "FireTeams"—pre-game lobbies where you group up. The browser *technically* supports them, but the implementation is so heavy that trying to load the list feels like pulling teeth. It lags, times out, or just fails to render half of them.

I started sniffing traffic while creating my own FireTeam to see what made them different in the API. They are technically standard "Servers," just with specific flags set.

1.  `attributes.COOPSERVER_b` is `true`.
2.  `attributes.LICENSEDSERVER_b` is `false` (Unlicensed).
3.  `attributes.__EOS_BLISTENING_b` is `true`.

I wrote a specific function to grab these immediately without the UI overhead.

```typescript
export async function getRawFireteams(): Promise<ILobbies> {
  const auth = await getEosAuth();
  
  // These flags are the signature of a FireTeam lobby
  const body = {
    criteria: [
      { key: "attributes.COOPSERVER_b", op: "EQUAL", value: true },
      { key: "attributes.LICENSEDSERVER_b", op: "EQUAL", value: false },
      { key: "attributes.__EOS_BLISTENING_b", op: "EQUAL", value: true },
    ],
    maxResults: 200,
  };
  
  // ... execute request ...
}
```

### Where are the names? (Resolving Players)

This was the trickiest part. The matchmaking API tells you *how many* players are in a server (`PLAYERCOUNT_l`), but it doesn't tell you *who*.

I was digging through the server metadata and found a field called `ADVERTISEDSESSIONID_s`. It looked like a pointer to another system.

Turns out, there is a separate endpoint: `lobby/v1/.../lobbies/filter`. If you feed it a list of these Session IDs, it spits back the full roster.

```typescript
export async function getPlayersInServers(serverIDs: string[]) {
  // Batch the IDs because EOS hates large payloads
  const batchRequests = serverIDBatches.map((batch) => {
    const body = {
      criteria: [
        {
          key: "attributes.ADVERTISEDSESSIONID_s",
          op: "ANY_OF",
          value: batch.map((id) => "Session:" + id),
        },
      ],
      maxResults: 35000,
    };
    // ... post request ...
  });
  
  // ... process responses ...
}
```

This gives us **EOS Product User IDs**. They are unique, but they aren't Steam IDs. You can't join their game or view their profile yet.

To finish the job, I had to use a third endpoint: `user/v9/product-users/search`. You send it a list of EOS IDs, and it returns the linked accounts.

By chaining these three calls (Server List -> Session Lookup -> User Resolve), I built a tracker that updates in real-time. It sees every server, identifies every player, and finds every FireTeam lobby, all without rendering a single frame of the game.