/**
 * Type declarations for miniapp global variables.
 *
 * These globals exist at runtime in their respective miniapp environments.
 * In non-miniapp environments they are undefined (detected via typeof checks).
 */

/* eslint-disable no-var */

declare var wx: Record<string, unknown> | undefined;
declare var my: Record<string, unknown> | undefined;
declare var tt: Record<string, unknown> | undefined;
declare var swan: Record<string, unknown> | undefined;

declare function getCurrentPages(): Array<{
  route?: string;
  __route__?: string;
}>;
