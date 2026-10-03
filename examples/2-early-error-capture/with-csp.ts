import { ameathEarlyErrorPlugin as viteEarly } from 'aemeath-js/build-plugins/vite';
import { AemeathEarlyErrorWebpackPlugin } from 'aemeath-js/build-plugins/webpack';
import { ameathEarlyErrorPlugin as rsbuildEarly } from 'aemeath-js/build-plugins/rsbuild';

// 仅为服务端占位符；每次响应替换成与 CSP 头匹配的新 nonce。
// Server placeholder only: replace per response with the nonce matching the CSP header.
const nonce = 'SERVER_NONCE_PLACEHOLDER';
export const vite = viteEarly({ nonce });
export const webpack = new AemeathEarlyErrorWebpackPlugin({ mode: 'inject', nonce });
export const rsbuild = rsbuildEarly({ nonce });
