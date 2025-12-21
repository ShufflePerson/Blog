---
title: "How I Bypassed GeForce Now's Security to Run Custom Apps"
description: "Think outside the box, find unturned stones, that's how you can find vulnerabilities!"
pubDate: 2025-12-21
heroImage: "gfn-landing.png"
tags: ["Reverse Engineering", "Geforce Now", "Injection", "Windows"]
---

### Escaping the Stream: How I Bypassed GeForce Now's Security to Run Custom Apps

**Posted:** December 2025
**Tags:** #ReverseEngineering, #GeForceNow, #ExploitDev, #MemoryInjection, #SandboxEscape

So, GeForce Now is great for gaming, but underneath the stream, it's a digital fortress. Most people think it just has a basic anti-cheat, but that's not even close. GFN runs one of the most hardened consumer sandboxes I've ever seen, designed with one goal: the user should only ever be able to play the game. Nothing else. This is the story of how I found a crack in that fortress and blew the doors open.

#### The GFN Fortress: A Look Under the Hood

Before I show you the exploit, you have to understand what we're up against. GFN's security isn't just a single program; it's a multi-layered system that polices every single action you take.

First, there's a **kernel-level driver**. This is the warden of the system, running with the highest privileges. It hooks fundamental Windows functions. When you try to run a program or load a DLL, GFN's driver intercepts that request before the OS even fully processes it. It checks the file against a strict whitelist of approved signatures and hashes. If it's not on the list, your session is terminated. No warning, no error, just gone. This makes testing and debugging a nightmare. One wrong move, and you're back at square one.

Then, you have the **Flag System**. This is their most clever defense. It's a dynamic security model that assigns a color-coded trust level to every single file and process:
*   **Green Flag:** The good stuff. The game itself, core Windows processes, anything signed by NVIDIA. They have full trust.
*   **Yellow Flag:** Sketchy but tolerated processes. Things like `cmd.exe` or a browser's command shell fall here. They can run, but they are treated like they're infected.
*   **Red Flag:** The kill list. Any file that's not on the whitelist is flagged as Red.

The real genius of this system is how the flags are inherited. If a trusted **Green Flag** process creates a file, that file is also Green. But if a suspicious **Yellow Flag** process (like our command prompt) downloads or creates a file, that new file is automatically born with a **Red Flag**. It's useless the moment it's created. This proactively kills almost all standard hacking techniques. You can't just download your malware and run it; the system is designed to poison your tools before you can even use them.

So, the challenge was clear. I had to find a way to create a file that didn't carry this taint.

#### Finding a Crack in the Wall

My first way in was a janky exploit using the Edge browser and MS Teams that let me pop a `cmd.exe` shell. But this wasn't a real win. Thanks to the security system, that `cmd` process was instantly branded with a Yellow Flag. It was a foothold, but I was still trapped.

I needed a reliable way to bootstrap the real exploit. The first step was to get some tools onto the machine using my yellow-flagged shell. The problem was that `winget`, the package manager, was also under scrutiny. Installing most things would trigger the security and kill the session. After some trial and error, I found that older, less-common versions of Python were not as strictly monitored.

```batch
:: 1. Silently install two specific Python versions that GFN's whitelist tolerated.
winget install Python.Python.3.1 --silent --force
winget install Python.Python.2 --silent --force

:: 2. Use Py2 to download my payload and injector script.
:: At this point, `input.exe` and `xd.py` exist, but they are RED FLAGGED.
"C:/Python27/python.exe" -c "..." > input.exe
"C:/Python27/python.exe" -c "..." > xd.py
```
This gave me a payload (`input.exe`) and an injector script (`xd.py`) on the machine. But because a Yellow Flag process downloaded them, they were both uselessly Red Flagged.

#### Turning Their Logic Against Them

My Red Flagged files couldn't run. The system was working as intended. But then I had the idea: the rule wasn't "no custom executables." The rule was "the child file inherits the parent's flag."

So I just needed to pick a better parent.

The plan became simple: find a running Green Flag process, and force *it* to create my executable for me. The game itself was the perfect target. First, my batch script had to find it.

```batch
:: A list of common game processes that are always Green Flagged.
set "process_names=csgo.exe Game_x64r.exe gamelaunchhelper.exe"

:: Loop through tasklist, find the first running game, and grab its PID.
for %%p in (%process_names%) do (
    for /f "tokens=2" %%a in ('tasklist ^| find "%%p"') do (
        set "pid=%%a"
        goto :found
    )
)
:found
```
With the game's PID, it was time for the main event. The batch script called my Python 3 injector, `xd.py`, and passed it the target PID.

```batch
:: Run the injector script with the game's PID as an argument.
"C:/Python31/python.exe" xd.py %pid%
```

This Python script is where the magic happens. It performs a classic process injection attack. It attaches to the Green Flagged game process, allocates a small chunk of memory inside it, and writes a tiny piece of custom machine code—shellcode—into that memory.

The shellcode was incredibly simple. Its only job was to call the Windows `CopyFileA` function, telling it to copy my Red Flagged `input.exe` to a new file named `unflagged.exe`.

Finally, the script calls `CreateRemoteThread`, telling the game process to start a new thread and run my shellcode.

From the outside, GFN's kernel driver saw nothing wrong. A trusted, Green Flagged process was creating a file. As per its own rules, the new file, `unflagged.exe`, was granted a Green Flag. I had successfully laundered my executable.

The final step was simple.

```batch
:: Now that unflagged.exe is Green Flagged, we can run it.
start "unflagged" unflagged.exe

:: Clean up all the scripts, installers, and payloads.
del *.bat
del *.py
rmdir /s /q "C:/Python31/"
rmdir /s /q "C:/Python27/"
```

It ran perfectly. I had full code execution inside one of the most locked-down cloud gaming environments out there. In the end, I didn't break their rules; I just used their own logic against them.

# Running on Geforce Now

![PoC](gfn.png)