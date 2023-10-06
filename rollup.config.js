import typescript from '@rollup/plugin-typescript'
import { getBabelOutputPlugin } from '@rollup/plugin-babel'

export default {
  input: 'src/phoenix-websocket.ts',
  output: [
    {
      file: 'build/phoenix-websocket.cjs',
      format: 'cjs',
    },
    {
      file: 'build/phoenix-websocket.js',
      format: 'es',
    },
  ],
  plugins: [
    typescript(),
    getBabelOutputPlugin({
      presets: ['@babel/preset-env'],
    }),
  ],
}
