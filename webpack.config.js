import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  entry: path.join(dirname, 'src/index.ts'),
  target: 'browserslist',
  experiments: {
    outputModule: true
  },
  output: {
    filename: 'tavern-roamer.js',
    path: path.join(dirname, 'dist'),
    clean: true,
    library: {
      type: 'module'
    }
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  devtool: 'source-map'
};
