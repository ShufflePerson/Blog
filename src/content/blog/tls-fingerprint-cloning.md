---
title: "Cloning TLS Fingerprints"
description: "Your HTTP headers are perfect. Your IP is residential. You still get blocked. Why? Because your handshake screams 'I am a bot'."
pubDate: 2025-12-22
heroImage: "TLS-LANDING.png"
socialImage: "./TLS-SMALL.png"
tags: ["NetSec", "C++", "Anti-Bot", "OpenSSL", "Fingerprinting"]
---

### Cloning TLS Fingerprints

You write a scraper. You buy high-quality residential proxies. You rotate your User-Agents. You copy the headers from Chrome perfectly. You hit the endpoint... and you get hit with a 403 Forbidden or a Cloudflare CAPTCHA immediately.

You check your IP—it’s clean. You check your headers—they are identical to a real browser. So how did they know?

They didn't look at *what* you said. They looked at *how* you said hello.

This is the world of **TLS Fingerprinting** (JA3/JA4), and it is currently the single biggest wall between a "script" and a "browser." Most developers treat SSL/TLS as a black box: you tell your library (Python `requests`, Node `axios`, or C++ `libcurl`) to connect, and it handles the handshake.

The problem is, every library handles that handshake differently. And those differences are a barcode tattooed on your forehead.

### The Anatomy of a Handshake

When you connect to a secure site via HTTPS, the very first thing that happens is the **Client Hello** packet. This is your browser introducing itself to the server.

"Hi, I want to talk. Here are the encryption languages (Cipher Suites) I speak, here are the Elliptic Curves I support, and here are the extensions I need."

A real Chrome browser sends these in a very specific order. It supports specific Greased parameters (random junk data to prevent ossification) and specific compression methods.

An OpenSSL-based script? It sends a completely different list. It might support older ciphers that Chrome dropped years ago. It sorts its extensions alphabetically instead of by usage.

Anti-bot companies like Cloudflare, Akamai, and Datadome just look at this packet. If you say "I am Chrome" in your User-Agent, but your TLS packet says "I am OpenSSL 1.1.1," you are lying. Blocked.

### Cloning the Ghost

To defeat this, we can't just use a high-level library. We have to get our hands dirty with the raw socket logic using C++ and OpenSSL. We need to manually construct the `SSL_CTX` (SSL Context) to force it to behave exactly like a browser.

I spent the weekend analyzing Chrome 120's handshake using Wireshark and `tls.peet.ws`. Here is how we replicate it.

First, we need to set up the **Cipher Suites**. By default, OpenSSL just enables "everything." Chrome is picky. We need to force the context to only offer the specific list that Chrome offers, including the new TLS 1.3 AES-GCM suites.

```cpp
#include <openssl/ssl.h>

void ConfigureChromeIdentity(SSL_CTX* ctx) {
    // This is the exact Cipher Suite list dumped from Chrome 120 (Windows).
    // Order matters. If you swap two of these, your JA3 hash changes.
    const char* chrome_ciphers = 
        "TLS_AES_128_GCM_SHA256:"
        "TLS_AES_256_GCM_SHA384:"
        "TLS_CHACHA20_POLY1305_SHA256:"
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "ECDHE-ECDSA-AES256-GCM-SHA384:"
        "ECDHE-RSA-AES256-GCM-SHA384:"
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-AES128-SHA:"
        "ECDHE-RSA-AES256-SHA:"
        "AES128-GCM-SHA256:"
        "AES256-GCM-SHA384";

    // Force OpenSSL to use strictly this list.
    if (SSL_CTX_set_cipher_list(ctx, chrome_ciphers) != 1) {
        // Handle error - this usually means you made a typo in the string
    }
    
    // For TLS 1.3, OpenSSL handles ciphers differently than 1.2
    if (SSL_CTX_set_ciphersuites(ctx, "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256") != 1) {
       // Log error
    }
}
```

### The Curves and ALPN

The ciphers are only half the battle. The next dead giveaway is the "Supported Groups" (Elliptic Curves) and the ALPN (Application-Layer Protocol Negotiation).

If you are a modern browser, you support `X25519`, `P-256`, and `P-384`. If you are a standard C++ script, you might default to just `P-256`.

Also, we need to tell the server we support HTTP/2 (`h2`). Even if we plan to send a simple HTTP/1.1 GET request, we *must* claim to support `h2` during the handshake, or we break the fingerprint.

```cpp
void ConfigureExtensions(SSL_CTX* ctx) {
    // 1. Set Elliptic Curves
    // Chrome prefers X25519 over everything else. 
    if (SSL_CTX_set1_groups_list(ctx, "X25519:P-256:P-384") != 1) {
         // Log error
    }

    // 2. Set ALPN (Application Layer Protocol Negotiation)
    // We need to advertise "h2" (HTTP/2) and "http/1.1".
    // Format is length-prefixed byte strings.
    unsigned char alpn[] = {
        0x02, 'h', '2',                  // Length 2, "h2"
        0x08, 'h', 't', 't', 'p', '/', '1', '.', '1' // Length 8, "http/1.1"
    };
    
    SSL_CTX_set_alpn_protos(ctx, alpn, sizeof(alpn));
}
```

### The Connect Loop

Once the context is armed with the fake identity, the connection logic is standard. However, we have to be careful not to let any default OpenSSL settings override our manual config.

```cpp
int main() {
    // Initialize the library
    init_openssl();
    SSL_CTX* ctx = SSL_CTX_new(TLS_client_method());

    // APPLY THE SPOOF
    ConfigureChromeIdentity(ctx);
    ConfigureExtensions(ctx);

    // Standard Socket setup (simplified for brevity)
    int sock = create_socket("tls.peet.ws", 443);
    
    // Bind SSL to the socket
    SSL* ssl = SSL_new(ctx);
    SSL_set_fd(ssl, sock);
    
    // Set SNI (Server Name Indication) - Mandatory for 99% of the web
    SSL_set_tlsext_host_name(ssl, "tls.peet.ws");

    // The moment of truth: The Handshake
    if (SSL_connect(ssl) <= 0) {
        ERR_print_errors_fp(stderr);
    } else {
        printf("Handshake success. We are in.\n");
    }
    
    // ... send HTTP GET and read response ...
}
```

### The "Good Enough" Problem

If you compile this and hit a detection API, you will see something interesting. Your **JA3 Hash** will likely be very, very close to Chrome's. But it might not be *perfect*.

Why? Because standard OpenSSL is stubborn. It likes to sort extensions in a specific internal order. Chrome sends extensions in a specific "random-looking" order that is actually deterministic. To get a 100% perfect match (where even the JA4 hash is identical), you simply cannot use the standard `libssl` that comes with Linux.

You have to go a level deeper. You have to either:
1.  Patch OpenSSL source code to allow manual extension ordering (painful).
2.  Use **BoringSSL** (Google's own fork of OpenSSL), which exposes APIs specifically for this kind of fine-tuning.

But for 95% of targets? This C++ spoofer is enough. It passes the "sanity check." The WAF sees the correct ciphers, the correct curves, and the correct ALPN. It assumes you are a browser, and it lets you through.

This is why "Client Hello" analysis is the current arms race in cybersecurity. We are moving past the era of blocking IPs and into the era of analyzing the DNA of the connection itself. And as long as the libraries allow us to tweak that DNA, the cat-and-mouse game continues.