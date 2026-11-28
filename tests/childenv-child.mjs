// Prints what the first SDK's `getDefaultEnvironment` gives for the platform named in argv[2]. The platform branch of that
// function is chosen when its module loads, so this child names the platform before it imports the SDK (tests/sdk-v1.mjs).
Object.defineProperty(process, 'platform', { value: process.argv[2] })
const { getDefaultEnvironment } = await import('./sdk-v1.mjs')
process.stdout.write(JSON.stringify(getDefaultEnvironment()))
