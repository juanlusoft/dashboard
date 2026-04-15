#!/usr/bin/env node
/**
 * HomePiNAS frontend build script
 * Bundles and minifies JS + CSS using esbuild
 *
 * Usage:
 *   node build.js          → production build
 *   node build.js --watch  → watch mode (dev)
 */

const esbuild = require('esbuild');
const path    = require('path');
const fs      = require('fs');

const watch   = process.argv.includes('--watch');
const outDir  = path.join(__dirname, 'frontend');

async function build() {
    console.log('[build] Starting frontend build...');

    // --- JavaScript ---------------------------------------------------------
    const jsCtx = await esbuild.context({
        entryPoints: ['frontend/main.js'],
        bundle:      true,
        minify:      true,
        format:      'esm',
        outfile:     'frontend/main.min.js',
        sourcemap:   false,
        target:      ['es2020'],
        logLevel:    'info',
    });

    // --- CSS ----------------------------------------------------------------
    const cssCtx = await esbuild.context({
        entryPoints: ['frontend/style.css'],
        bundle:      false,
        minify:      true,
        outfile:     'frontend/style.min.css',
        logLevel:    'info',
    });

    const responsiveCssCtx = await esbuild.context({
        entryPoints: ['frontend/responsive.css'],
        bundle:      false,
        minify:      true,
        outfile:     'frontend/responsive.min.css',
        logLevel:    'info',
    });

    if (watch) {
        await jsCtx.watch();
        await cssCtx.watch();
        await responsiveCssCtx.watch();
        console.log('[build] Watching for changes...');
    } else {
        await jsCtx.rebuild();
        await cssCtx.rebuild();
        await responsiveCssCtx.rebuild();

        await jsCtx.dispose();
        await cssCtx.dispose();
        await responsiveCssCtx.dispose();

        // Print size comparison
        const sizes = [
            ['frontend/main.js',           'frontend/main.min.js'],
            ['frontend/style.css',         'frontend/style.min.css'],
            ['frontend/responsive.css',    'frontend/responsive.min.css'],
        ];
        console.log('\n[build] Size comparison:');
        for (const [src, out] of sizes) {
            const before = fs.statSync(src).size;
            const after  = fs.statSync(out).size;
            const pct    = ((1 - after / before) * 100).toFixed(1);
            console.log(`  ${src.padEnd(32)} ${kb(before).padStart(8)} → ${kb(after).padStart(8)}  (-${pct}%)`);
        }
        console.log('\n[build] Done.');
    }
}

function kb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }

build().catch(err => { console.error(err); process.exit(1); });
