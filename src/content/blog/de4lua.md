---
title: "Lua obfuscation and the defense"
description: "A look into the arms race of Lua obfuscation, and how I built an AST-based deobfuscator to win it by treating code as data."
pubDate: 2025-12-21
heroImage: "lua.png"
socialImage: "./lua-small.png"
tags: ["Reverse Engineering", "Lua", "AST", "Static Analysis", "TypeScript"]
---

You’ve seen it. A Lua script that's been put through a meat grinder. Maybe it's a paid addon for a game, an anti-cheat client, or some piece of malware. It’s a 500-line nightmare that looks like a cat walked across a keyboard firing off random hex codes and meaningless variable names. The real logic is buried under layers of garbage, the strings are encrypted, and trying to figure out what it *actually does* is like trying to unscramble an egg.

Most people see that and hit a wall. They either blindly trust the black box or throw it away.

But my brain is wired differently. I see that wall of text and I don't see a barrier. I see a puzzle. A beautifully complex, adversarial game. The obfuscator's goal is to maximize entropy—to make the code so chaotic that no human can follow it. My goal is to reverse that entropy, to restore order and reveal the original intent.

This is the story of De4Lua, a project I built to fight this war systematically. And the weapon of choice isn't some brittle regex script that breaks if you add a space. The weapon is the Abstract Syntax Tree.

Before you can fight, you have to know the battlefield. A Lua script really exists in two forms, and where you choose to fight determines everything. The first is the **source code**, the `.lua` file itself. It’s the human-readable blueprint. Deobfuscating here is about untangling structure and data. This is De4Lua's turf. The second is **bytecode**, the low-level, binary instructions the Lua Virtual Machine (VM) actually executes. Variable names are gone, comments are gone, everything is reduced to opcodes. Trying to reverse that is a whole different war, and it's brutally difficult.

To build a deobfuscator, I had to learn to think like an obfuscator. They have an entire arsenal of techniques, all designed to make an analyst's life hell.

They usually start with the easiest target, the data itself. If you can't read the strings, you don't know what files are being accessed or what URLs are being hit. They’ll do simple things like converting strings to **hex escape codes** (`"Hello"` becomes `"\x48\x65..."`) or they'll get more annoying by hiding all their strings in a **giant master table**, referencing them by index. The final boss of data concealment is full-on **encryption**, where every string is a garbage blob that gets fed to a custom decryption function before it's used.

Hiding strings is one thing, but the real damage comes when they attack the code's logic. This is where they try to destroy the natural flow of the program. They'll insert **Opaque Predicates**, which are `if` statements that are always false (`if 2+2==5 then...`) but are filled with hundreds of lines of confusing, plausible-looking code just to send you on a wild goose chase.

The true nightmare fuel, though, is **Control Flow Flattening**. This is the single most effective technique against a human. They take a normal script and completely shatter its structure, rebuilding it as a giant state machine inside a `while true do` loop. A clean sequence of `A(); B(); C();` is turned into a twisted mess of `if state == 1 then A() state=4 end`, `if state == 4 then B() state=2 end`, and so on, with the state numbers scrambled. It's designed to make you give up. It’s brutally effective.

So how do you fight this orchestrated chaos? You don't. You refuse to play their game. You don't try to *read* the mess. You change the battlefield.

Instead of reading the text, De4Lua feeds the entire ugly script to a parser (`luaparse`) and transforms it into an **Abstract Syntax Tree (AST)**. An AST is the pure, logical structure of the code. All the noise, formatting tricks, and text-based garbage disappear. It becomes a traversable graph of nodes. The simple line `local a = 1 + 2` is no longer a string of characters. It's a `LocalStatement` node containing a `BinaryExpression` node.

This is the key. Once the code is a predictable data structure, we can write algorithms to clean it. That's the core of De4Lua's `logic` pipeline. It's an iterative process—we peel the onion one layer at a time, because deobfuscating one layer often reveals new opportunities in the next.

Let's walk through an attack on a single piece of obfuscated code:
`local V1 = "\x73\x65\x63\x72\x65\x74"; if (10 * 2) - 15 > 0 then print(V1) end`

When De4Lua ingests this, it becomes a tree of nodes. The pipeline begins.

First, the **String Recovery** pass (`remove_hex_strings.ts`) walks the tree. It finds any `StringLiteral` node encoded with hex, decodes it, and rebuilds the node with the clean string. The AST now represents: `local V1 = "secret"; if (10 * 2) - 15 > 0 then print(V1) end`

On the next cycle, the **Constant Folding** pass (`calculate_math.ts`) goes to work. It walks the tree looking for `BinaryExpression` nodes where both sides are just numbers. It finds `10 * 2`, calculates `20`, and replaces that entire expression node with a single `NumericLiteral` node. The AST now represents: `local V1 = "secret"; if 20 - 15 > 0 then print(V1) end`

The cycles are critical. We run the folding pass again. It now finds `20 - 15` and collapses it to `5`. Then `5 > 0` becomes `true`. The Opaque Predicate has been completely defeated through pure computation. The AST is now equivalent to `if true then ...`, and another pass can unwrap the `if` statement entirely since it's no longer conditional.

With each cycle, the AST gets simpler. When the cycles are done, the final, clean AST is passed to my `ast_builder`, which turns the structured data back into readable, formatted Lua source code.

De4Lua can handle a lot of the common tricks, but this arms race never ends. To fight the high-end obfuscators, you need even more powerful weapons. The next step is **Symbolic Execution**, an engine that can simplify expressions with variables, proving that `(x * 2) / 2` is always just `x`. And the end boss is **Control Flow De-flattening**, which requires building a graph of the state machine's logic and using algorithms to reconstruct the original loops and branches. That’s the next big challenge I'm itching to tackle.

Obfuscation isn't magic. It's just a set of algorithms designed to create chaos. And any algorithm can be analyzed, understood, and reversed. De4Lua is my first major offensive in that war. It's a statement: if you build a wall, I'm going to enjoy figuring out how to take it apart, brick by brick.

You can check out the source code and see the chaos engine for yourself on [my GitHub](https://github.com/ShufflePerson/De4Lua).