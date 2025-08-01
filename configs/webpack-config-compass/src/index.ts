import {
  type ResolveOptions,
  type WebpackPluginInstance,
  type Configuration,
  ProvidePlugin,
} from 'webpack';
import { merge } from 'webpack-merge';
import ReactRefreshWebpackPlugin from '@pmmmwh/react-refresh-webpack-plugin';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no types exist for this library
import DuplicatePackageCheckerPlugin from '@cerner/duplicate-package-checker-webpack-plugin';
import path from 'path';
import { builtinModules } from 'module';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import { WebpackPluginStartElectron } from './webpack-plugin-start-electron';
import type { ConfigArgs, WebpackConfig } from './args';
import { isServe, webpackArgsWithDefaults } from './args';
import {
  sourceMapLoader,
  javascriptLoader,
  nodeLoader,
  sourceLoader,
  cssLoader,
  lessLoader,
  assetsLoader,
  resourceLoader,
  sharedObjectLoader,
} from './loaders';
import {
  entriesToNamedEntries,
  toCommonJsExternal,
  entriesToHtml,
  getLibraryNameFromCwd,
} from './util';
import { sharedExternals, pluginExternals } from './externals';
import { WebpackPluginMulticompilerProgress } from './webpack-plugin-multicompiler-progress';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

const sharedIgnoreWarnings: NonNullable<Configuration['ignoreWarnings']> = [
  // Usually caused by published d.ts files pointing to non-existent ts files in
  // the ignored for publish source folder
  /Failed to parse source map.+?ENOENT/,
  // Expected in most cases for Compass
  /require function is used in a way in which dependencies cannot be statically extracted/,
  /the request of a dependency is an expression/,
  // Optional, platform-specific dependencies (mostly from driver)
  /Module not found.+?(mongo_crypt_v1.(dll|so|dylib)|@mongodb-js\/zstd|aws-crt|gcp-metadata)/,
  // Optional, comes from emotion trying to (safely) use react apis that we
  // don't have in React 17
  /export 'useInsertionEffect'/,
];

const sharedResolveOptions = (
  target: ConfigArgs['target']
): Pick<
  ResolveOptions,
  'mainFields' | 'exportsFields' | 'extensions' | 'alias'
> => {
  if (typeof target === 'string') {
    target = [target];
  }
  return {
    // This replicates webpack behavior with additional special `compass:` keys
    // taking priority over the default ones that webpack uses
    //
    // See https://webpack.js.org/configuration/resolve/#resolvemainfields
    mainFields:
      target?.includes('web') || target?.includes('webworker')
        ? [
            'compass:browser',
            'compass:module',
            'compass:main',
            'browser',
            'module',
            'main',
          ]
        : ['compass:module', 'compass:main', 'module', 'main'],
    exportsFields: ['compass:exports', 'exports'],
    extensions: ['.jsx', '.tsx', '.ts', '...'],
    alias: {
      // Removes `browserslist` that is pulled in by `babel` and is unnecessary
      // as well as being a particularly large dependency.
      browserslist: false,
      // Removes `ampersand-sync`: `ampersand-sync` is required by `ampersand-model`,
      // but is not actually used in Compass, we don't fetch and save models via http.
      // Additionally `ampersand-sync` brings into the bundle a number of other dependencies
      // that are outdated and having known vulnerabilities.
      'ampersand-sync': false,

      // Leafygreen tries to include all the server-side emotion stuff in the
      // client bundle, this requires packaging a ton of otherwise unneccessary
      // polyfills.To work around this, we're providing a minimally required
      // polyfill for code not to break. This is mostly a problem for our web
      // packages, but also not a bad thing at all for the electron app itself.
      '@emotion/server/create-instance': path.resolve(
        __dirname,
        '..',
        'polyfills',
        '@emotion',
        'server',
        'create-instance',
        'index.js'
      ),

      // This is an optional dependency of the AWS SDK that doesn't look like
      // an optional dependency to webpack because it's not wrapped in try/catch.
      '@aws-sdk/client-sso-oidc': false,

      // Some lg test helpers that are getting bundled due to re-exporting from
      // the actual component packages, never needed in the webpack bundles
      '@lg-tools/test-harnesses': false,
    },
  };
};

const providePlugin = new ProvidePlugin({
  URL: ['whatwg-url', 'URL'],
  URLSearchParams: ['whatwg-url', 'URLSearchParams'],
});

export function createElectronMainConfig(
  args: Partial<ConfigArgs>
): WebpackConfig {
  const opts = webpackArgsWithDefaults(args, { target: 'electron-main' });
  const namedEntry = entriesToNamedEntries(opts.entry);

  const config = {
    entry: namedEntry,
    devtool: opts.devtool,
    output: {
      path: opts.outputPath,
      filename: opts.outputFilename ?? '[name].[contenthash].main.js',
      assetModuleFilename: 'assets/[name].[hash][ext]',
      strictModuleErrorHandling: true,
      strictModuleExceptionHandling: true,
    },
    mode: opts.mode,
    target: opts.target,
    module: {
      rules: [
        sourceMapLoader(opts),
        javascriptLoader(opts),
        nodeLoader(opts),
        resourceLoader(opts),
        sharedObjectLoader(opts),
        sourceLoader(opts),
      ],
      parser: {
        javascript: {
          // Webpack compile time check for imports matching exports is too strict
          // in cases where the code expects some name export to be optional
          // (webpack will break the build if it fails to statically see the
          // matching export) this is why we switch the check to just warn. If
          // this ever hides a real case where a missing import is being used, it
          // will definitely break in runtime anyway
          importExportsPresence: 'warn' as const,
        },
      },
    },
    node: false as const,
    externals: toCommonJsExternal(sharedExternals),
    resolve: {
      // To avoid resolving the `browser` field
      aliasFields: [],
      ...sharedResolveOptions(opts.target),
    },
    plugins: [new WebpackPluginMulticompilerProgress()],
    ignoreWarnings: sharedIgnoreWarnings,
  };

  return merge<WebpackConfig>(
    config,
    opts.mode === 'development'
      ? {
          output: {
            filename: opts.outputFilename ?? '[name].main.js',
            assetModuleFilename: 'assets/[name][ext]',
          },
        }
      : {},
    isServe(opts) ? { plugins: [new WebpackPluginStartElectron()] } : {},
    opts.analyze
      ? {
          plugins: [
            // Plugin types are not matching Webpack 5, but they work
            new BundleAnalyzerPlugin({
              logLevel: 'silent',
              analyzerPort: 'auto',
            }) as unknown as WebpackPluginInstance,

            new DuplicatePackageCheckerPlugin(),
          ],
        }
      : {}
  );
}

export function createElectronRendererConfig(
  args: Partial<ConfigArgs>
): WebpackConfig {
  const opts = webpackArgsWithDefaults(args, { target: 'electron-renderer' });
  const entries = entriesToNamedEntries(opts.entry);

  const config = {
    entry: entries,
    devtool: opts.devtool,
    output: {
      path: opts.outputPath,
      filename: opts.outputFilename ?? '[name].[contenthash].renderer.js',
      assetModuleFilename: 'assets/[name].[hash][ext]',
      library: opts.library ?? getLibraryNameFromCwd(opts.cwd),
      libraryTarget: 'umd',
      strictModuleErrorHandling: true,
      strictModuleExceptionHandling: true,
      globalObject: 'globalThis',
    },
    mode: opts.mode,
    target: opts.target,
    module: {
      rules: [
        sourceMapLoader(opts),
        javascriptLoader(opts),
        nodeLoader(opts),
        cssLoader(opts),
        lessLoader(opts),
        assetsLoader(opts),
        sharedObjectLoader(opts),
        sourceLoader(opts),
      ],
      parser: {
        javascript: {
          importExportsPresence: 'warn' as const,
        },
      },
    },
    plugins: [
      ...entriesToHtml(entries),
      new WebpackPluginMulticompilerProgress(),
      providePlugin,
    ],
    node: false as const,
    externals: toCommonJsExternal(sharedExternals),
    resolve: {
      // To avoid resolving the `browser` field
      aliasFields: [],
      ...sharedResolveOptions(opts.target),
    },
    ignoreWarnings: sharedIgnoreWarnings,
  };

  return merge<WebpackConfig>(
    config,
    opts.mode === 'development'
      ? {
          output: {
            filename: opts.outputFilename ?? '[name].renderer.js',
            assetModuleFilename: 'assets/[name][ext]',
          },
        }
      : {},
    opts.mode === 'production'
      ? {
          plugins: [
            new MiniCssExtractPlugin(),
          ] as unknown as WebpackPluginInstance[],
        }
      : {},
    isServe(opts)
      ? {
          devServer: {
            magicHtml: false,
            port: opts.devServerPort,
            devMiddleware: {
              // It's slower than in-memory fs, but required so that we can
              // start the electron app
              writeToDisk: true,
            },
            client: {
              overlay: {
                errors: true,
                warnings: false,
              },
            },
            https: false,
            hot: opts.hot,
          },
          plugins: [
            new WebpackPluginStartElectron() as WebpackPluginInstance,
          ].concat(
            opts.hot
              ? [
                  // Plugin types are not matching Webpack 5, but they work
                  new ReactRefreshWebpackPlugin() as unknown as WebpackPluginInstance,
                ]
              : []
          ),
        }
      : {},
    opts.analyze
      ? {
          plugins: [
            // Plugin types are not matching Webpack 5, but they work
            new BundleAnalyzerPlugin({
              logLevel: 'silent',
              analyzerPort: 'auto',
            }) as unknown as WebpackPluginInstance,

            new DuplicatePackageCheckerPlugin(),
          ],
        }
      : {}
  );
}

export function createWebConfig(args: Partial<ConfigArgs>): WebpackConfig {
  const opts = webpackArgsWithDefaults(args, { target: 'web' });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { peerDependencies } = require(path.join(opts.cwd, 'package.json')) as {
    peerDependencies: Record<string, string>;
  };

  return {
    entry: entriesToNamedEntries(opts.entry),
    devtool: opts.devtool,
    output: {
      path: opts.outputPath,
      filename: opts.outputFilename ?? '[name].js',
      assetModuleFilename: 'assets/[name][ext]',
      library: opts.library ?? getLibraryNameFromCwd(opts.cwd),
      libraryTarget: 'umd',
      // These two options are subtly different, and while
      // `strictModuleExceptionHandling` is deprecated, it is the only
      // one that actually gives us the right behavior currently.
      // https://github.com/webpack/webpack/blob/3ad4fcac25a976277f2d9cceb37bc81602e96b13/lib/javascript/JavascriptModulesPlugin.js#L1326-L1346
      // Note that hot module reloading turns these on by default,
      // so this is only affecting production builds and not the
      // typical development mode that we work in.
      strictModuleErrorHandling: true,
      strictModuleExceptionHandling: true,
      globalObject: 'globalThis',
    },
    mode: opts.mode,
    target: opts.target,
    module: {
      rules: [
        sourceMapLoader(opts),
        javascriptLoader(opts, true),
        nodeLoader(opts),
        cssLoader(opts, true),
        lessLoader(opts),
        assetsLoader(opts),
        sourceLoader(opts),
      ],
      parser: {
        javascript: {
          importExportsPresence: 'warn' as const,
        },
      },
    },
    // This follows current Compass plugin behavior and is here more or less to
    // keep compat for the external plugin users
    externals: {
      ...toCommonJsExternal(sharedExternals),
      ...toCommonJsExternal(Object.keys(peerDependencies ?? {})),
      ...toCommonJsExternal(builtinModules.flatMap((m) => [m, `node:${m}`])),
    },
    resolve: {
      ...sharedResolveOptions(opts.target),
    },
    ignoreWarnings: sharedIgnoreWarnings,
    plugins: [
      providePlugin,
      ...(isServe(opts) && opts.hot
        ? [
            // Plugin types are not matching Webpack 5, but they work
            new ReactRefreshWebpackPlugin() as unknown as WebpackPluginInstance,
          ]
        : opts.analyze
        ? [
            // Plugin types are not matching Webpack 5, but they work
            new BundleAnalyzerPlugin({
              logLevel: 'silent',
              analyzerPort: 'auto',
            }) as unknown as WebpackPluginInstance,

            new DuplicatePackageCheckerPlugin(),
          ]
        : []),
    ],
  };
}

export { sharedExternals, pluginExternals };
export { webpackArgsWithDefaults, isServe } from './args';
export { default as webpack } from 'webpack';
export { merge } from 'webpack-merge';
export { default as WebpackDevServer } from 'webpack-dev-server';
