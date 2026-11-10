// Expo's preset, plus fixes for dependencies that use syntax Metro or Hermes can't take:
// - oRPC's client (@orpc/*): Hermes can't parse an async arrow whose rest parameter is destructured with a default
//   (`async (...[input, options = {}]) =>`, "invalid destructuring target"), so those packages get their parameters
//   compiled down.
// - noVNC (@novnc/novnc, in the Screen's DOM component): its browser checks end with a top-level await
//   (`supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport()`), which Metro's bundles, not being ES
//   modules, can't run ("await is only valid in async functions"). It becomes `….then((value) => (x = value))`: the
//   export is a live binding, set once the check is done, well before a stream asks which encodings it supports.
const isOrpc = (filename) => !!filename && /[\\/]@orpc[\\/]/.test(filename)
const isNoVncBrowser = (filename) => !!filename && /[\\/]@novnc[\\/]novnc[\\/]core[\\/]util[\\/]browser\.js$/.test(filename)

function topLevelAwaitToThen({ types: t }) {
  return {
    visitor: {
      Program(program) {
        for (const statement of program.get('body')) {
          const expression = statement.isExpressionStatement() && statement.get('expression')
          if (!expression || !expression.isAssignmentExpression() || !expression.get('right').isAwaitExpression()) continue
          const { left, right } = expression.node
          const value = t.identifier('value')
          statement.replaceWith(
            t.expressionStatement(
              t.callExpression(t.memberExpression(right.argument, t.identifier('then')), [t.arrowFunctionExpression([value], t.assignmentExpression('=', left, value))]),
            ),
          )
        }
      },
    },
  }
}

module.exports = (api) => {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    // Functions, not RegExps: Expo loads this config once without a filename, which a RegExp test refuses.
    overrides: [
      { test: isOrpc, plugins: ['@babel/plugin-transform-parameters'] },
      { test: isNoVncBrowser, plugins: [topLevelAwaitToThen] },
    ],
  }
}
