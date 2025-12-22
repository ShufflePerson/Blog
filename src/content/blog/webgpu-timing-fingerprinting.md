---
title: "Fingerprinting WebGPU Latency"
description: "Browsers can lie about their name. They can't lie about their physics. Detecting bots by measuring the speed of light (and silicon)."
pubDate: 2025-12-25
heroImage: "./silicon-hero.png"
socialImage: "./silicon-small.png"
tags: ["WebGPU", "Fingerprinting", "Bot Detection", "Reverse Engineering", "JavaScript"]
---

### The Silicon Breach

We have reached a stalemate in the browser fingerprinting war.

On one side, we have the "Anti-Detect" browsers (Multilogin, GoLogin, Dolphin). They are brilliant. They don't just change the User-Agent string; they hook into the browser's internal APIs. When a script asks "What GPU is this?", the browser doesn't check the hardware. It checks a configuration file and replies: "I am an Apple M2 Max," even if it’s running on a cheap Intel Xeon server in a datacenter.

The standard defenses—Canvas fingerprinting, AudioContext, Font enumeration—are essentially dead. They rely on the browser telling the truth about how it renders data. If the browser is modified to lie, the fingerprint is useless.

But there is one thing a browser cannot spoof: **Physics.**

You can fake the *name* of a graphics card. You cannot fake the *speed* at which it calculates a 10,000 x 10,000 matrix multiplication.

This is the concept behind **WebGPU Compute Latency Fingerprinting**. We stop asking the browser *what* it is, and we start measuring *how fast* it thinks.

### Silicon Binning

Every microchip is different. Even two identical RTX 4090s coming off the same assembly line have microscopic differences in their silicon wafers. This is called "binning." Under extreme load, their voltage regulation and clock stability vary slightly.

When we move to the virtual world (bots), the difference becomes massive.

A real device has a dedicated GPU.
A bot (usually inside a VM or a Docker container) uses a virtualized GPU or, worse, software rendering (SwiftShader).

If I force your browser to crunch a massive mathematical workload, a real GPU will finish it in 12ms with a variance of ±0.5ms. A virtualized GPU might finish it in 12ms, but the variance will spike to ±15ms because it’s fighting for resources with the host OS.

We can measure this.

### WebGPU Compute Shaders

We don't use WebGL (which draws pictures). We use WebGPU, the modern standard that gives us low-level access to the GPU cores.

We create a **Compute Shader**. This is a program that doesn't render pixels; it just does math. I wrote a shader that performs a chaotic loop of sine, cosine, and tangent operations on a buffer of 1,000,000 floating-point numbers.

It looks like this (WGSL):

```rust
// The "Heavy" Math
fn chaotic_math(val: f32) -> f32 {
    var x = val;
    // Perform heavy floating point trig math 500 times per thread
    for (var i = 0; i < 500; i++) {
        x = sin(x) * cos(x) + tan(x * 0.001);
    }
    return x;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
    let index = global_id.x;
    // Read, crunch, write
    data[index] = chaotic_math(data[index]);
}
```

This code is intentionally inefficient. It forces the GPU's Arithmetic Logic Units (ALUs) to sweat.

### The Execution & The "False Positive" Trap

The implementation seems simple: start a timer, dispatch the shader to the GPU, wait for it to finish, stop the timer.

```javascript
const start = performance.now();
// Submit work to GPU
device.queue.submit([commandEncoder.finish()]);
// Wait for the physical hardware to signal "Done"
await device.queue.onSubmittedWorkDone();
const end = performance.now();
```

When I first ran this on my local machine (a high-end MacBook), I expected a perfect, low-latency score.

**I got flagged as a bot.**

My script reported "Critical Risk: High Variance."
The average time was fast (14ms), but the jitter was insane (27ms spikes).

This happens because `performance.now()` measures the time on the *CPU's* clock. Even though the GPU finished the math instantly, my main thread was busy rendering a YouTube video in another tab. The OS scheduler delayed the "Done" signal.

If we want to detect bots, we have to ignore the Operating System's noise.

### Statistical Clipping

To solve this, I implemented a "clean-up" algorithm. I run the stress test 12 times.
1.  **Discard the first 2 runs:** These are "Cold Starts" where the shader is still compiling.
2.  **Sort the remaining 10 runs.**
3.  **Discard the slowest 20%:** These are the runs where the OS scheduler interrupted us.
4.  **Average the remainder.**

Once I applied this logic, the data clarified immediately.

*   **My MacBook:** 12.4ms Average / 0.2ms Jitter. (Solid Green)
*   **My Cloud VM (Puppeteer):** 45ms Average / 18ms Jitter. (Solid Red)

### The Privacy Cat-and-Mouse

The funniest part of this research is seeing how browser vendors try to stop it.

Recently, the W3C removed the `adapter.requestAdapterInfo()` function from the WebGPU spec. They did this specifically to stop developers from seeing the GPU model name (e.g., "Nvidia GTX 1080").

They removed the label on the engine. But they can't hide the horsepower.

By stripping the labels, they actually made this latency attack *more* valuable. I don't care if you claim to be an iPhone 15. If your compute latency matches a Linux server, you are a Linux server.

### The Downsides

There is no such thing as a perfect silver bullet. This method has costs:

1.  For the 500ms that this test runs, I am pegging your GPU at 100%. If you put this on a landing page, mobile users might notice their phone getting warm.
2.  A user with a $4,000 gaming rig might have a GPU so fast that the execution time is 0.1ms. If the code isn't calibrated for that, it might look like an anomaly.
3.  If the user is actually rendering a 4K video while visiting your site, their GPU is legitimately busy. High variance doesn't *always* mean bot.

### Final Thoughts

We are moving into an era of "Behavioral Biometrics" at the hardware level. The headers are compromised. The IP addresses are rotated. The cookies are cleared.

But silicon doesn't lie. Until bot farms start buying thousands of physical iPhones to run their scrapers (which makes the attack economically unviable), measuring the physics of the device is our best bet at distinguishing man from machine.