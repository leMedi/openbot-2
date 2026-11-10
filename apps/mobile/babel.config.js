// Expo's preset, plus one fix for oRPC's client (@orpc/*): Hermes can't parse an async arrow whose rest parameter is
// destructured with a default (`async (...[input, options = {}]) =>`, "invalid destructuring target"), so those
// packages get their parameters compiled down.
module.exports = (api) => {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    // A function, not a RegExp: Expo loads this config once without a filename, which a RegExp test refuses.
    overrides: [{ test: (filename) => !!filename && /[\\/]@orpc[\\/]/.test(filename), plugins: ['@babel/plugin-transform-parameters'] }],
  }
}
