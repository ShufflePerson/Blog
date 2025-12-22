---
title: "Detecting Mismatched TLS Fingerprints"
description: "Your User-Agent says Chrome on Windows. Your handshake says OpenSSL on Linux. One of them is lying. Here is how I catch it programmatically."
pubDate: 2025-12-24
heroImage: "tls-defense.png"
socialImage: "./tls-defense-small.png"
tags: ["Blue Team", "Threat Intel", "Forensics", "JA3", "Anomaly Detection"]
---

### The Lie in the Packet

In the previous post, we looked at how to forge a TLS handshake to look like a legitimate browser. Now, I want to flip the table. If I am the CISO of a bank or a crypto exchange, how do I catch the person running that script?

The reality of modern bot detection is that we stop looking at *who* the user is (IP, Cookies) and start looking at *what* they are. And the most damning piece of evidence is the **TLS Fingerprint Mismatch**.

Every browser version has a unique "signature" in how it negotiates encryption. Chrome 120 on Windows 10 sends a specific set of Cipher Suites, in a specific order, with specific extensions.

When a bot tries to visit your site, it often lies. It sends a User-Agent header that claims:
`Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)...`

But the underlying TLS packet tells a completely different story. It’s like someone walking into a bank claiming to be a local construction worker, but they are wearing a pristine Italian suit and speaking with a thick heavy accent. The details don't add up.

### The Theory of Entropy and Ordering

The easiest way to catch a lazy bot is **Cipher Suite Ordering**.

Standard networking libraries (like Python's `requests` or the default `OpenSSL` configurations) tend to be very orderly. When they send the list of encryption methods they support, they often sort them by internal ID or strength.

Browsers are chaotic. Chrome, for example, intentionally randomizes parts of its handshake (using a mechanism called GREASE) to prevent servers from becoming too rigid.

If I see a connection where the Cipher Suites are perfectly sorted by their hex codes? **Red flag.** That’s not a human on an iPhone. That’s a script.

### The "Consistency Check"

To detect this at scale, we don't need fancy AI. We just need a lookup table.

We build a database of "Known Good" fingerprints. We know exactly what the JA3 hash (a method of fingerprinting the handshake) looks like for Chrome 120, Firefox 115, and Safari 17.

When a request hits our load balancer, we run a simple logic check:

1.  Extract the `User-Agent` header.
2.  Calculate the `JA3` hash of the incoming connection.
3.  Query the database: *Does this JA3 belong to this User-Agent?*

If the User-Agent is "Chrome" but the JA3 matches "Golang HTTP Client," we drop the packet instantly.

Here is what the logic looks like in a C++ backend filter context:

```cpp
struct ClientMetadata {
    std::string user_agent;
    std::string ja3_hash;
    std::vector<uint16_t> cipher_suites;
};

bool IsImposter(const ClientMetadata& client) {
    // 1. Check for GREASE (The easiest filter)
    // Modern browsers (Chrome/Firefox) ALWAYS send GREASE values (random 0x?a?a bytes).
    // Most default bot scripts forget to include these.
    if (client.user_agent.find("Chrome") != std::string::npos) {
        bool has_grease = false;
        for (auto cipher : client.cipher_suites) {
            if ((cipher & 0x0f0f) == 0x0a0a) { 
                has_grease = true; 
                break; 
            }
        }
        if (!has_grease) {
            // Claiming to be Chrome but no GREASE? 
            // 99.9% probability it's a bot.
            return true; 
        }
    }

    // 2. The Database Lookup (Simplified)
    // In a real system, this is a hash map look up.
    std::string expected_hash = GetKnownHash(client.user_agent);
    
    if (expected_hash.empty()) {
        // Unknown User-Agent. Suspicious, but maybe just a new browser.
        return false; 
    }

    if (client.ja3_hash != expected_hash) {
        // MATCH FAILURE. 
        // The header says "Firefox" but the handshake says "Python".
        return true; 
    }

    return false;
}
```

### The "Uncanny Valley" of Spoofing

Advanced attackers (like the method I showed in the previous post) will try to mimic the JA3 hash. They will force the ciphers and extensions to match Chrome's list.

But even then, they often fail the **TCP Fingerprint** test.

This is Layer 4. Even if you fake the Layer 5 (TLS) handshake perfectly, your operating system leaves traces in the TCP packet itself.
*   **Window Size:** Windows, Linux, and macOS use different default TCP Window sizes.
*   **TTL (Time To Live):** Windows defaults to 128. Linux defaults to 64.

**The Scenario:**
A connection comes in.
*   **User-Agent:** Windows 10 / Chrome.
*   **TLS Fingerprint:** Matches Windows 10 / Chrome perfectly (Good job, spoofer).
*   **IP Packet TTL:** 63 (This indicates a Linux machine, likely a server).

**Caught.**

You cannot easily spoof the TTL without root privileges on the attacking machine, and many botters renting cheap proxies don't have that level of control.

### Why This Matters

For a long time, the security industry relied on "reputation." If an IP had sent spam before, block it. If it was from a data center, block it.

But IPv6 and residential proxies killed that strategy. There are too many IPs to track, and bad actors are using the same "clean" IPs that your grandmother uses.

The industry has pivoted to **behavioral and metadata analysis**. We don't care *where* you are coming from. We care *if your story holds together*.

If you are a developer building an API, you should stop trusting `User-Agent` headers blindly. They are just text strings. They are meaningless. Look at the handshake. Look at the order of the headers. Look at the TCP flags.

The truth is always in the binary, not the ASCII.