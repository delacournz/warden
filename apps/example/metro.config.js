const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, {
  // relative path to your global.css file (from step 3)
  cssEntryFile: './src/styles/global.css',
  // path where Uniwind auto-generates typings
  dtsFile: './src/uniwind-types.d.ts',
});
