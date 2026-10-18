/**
 * Import fallback for packages the Harness provides to a running plugin but that a
 * plain checkout does not have on its resolution path.
 *
 * Used by tests that import the host entry outside the Harness. Resolution is tried
 * normally first, so a machine where these packages exist gets the real ones; the
 * stub is only what makes the import graph loadable, never anything a test drives.
 *
 * @module dsh-opencode-bridge/test/host-modules-fallback
 */

/** The stubbed packages, with the smallest shape their importers need. */
const STUBS = {
  '@deepseek-ai/dsh-llm':
    'export const resolveImageAttachmentAccess = () => ({});'
    + 'export const resolveRetryPolicy = () => ({});',
  '@deepseek-ai/dsh-llm-pi-ai': 'export class PiAiAdapter {}',
}

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || STUBS[specifier] === undefined) throw error
    return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true }
  }
}
