import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// this loads all the env vars from .env files when running tests.
// you should not be connecting to the prod db anyways!
export default defineConfig(({ mode }) => ({
  test: {
    // mode defines what ".env.{mode}" file to choose if exists
    env: loadEnv(mode, process.cwd(), ''),
    testTimeout: 10_000 // ms
  },
}))