// @flow
const prettier = require("rollup-plugin-prettier");
const resolve = require("rollup-plugin-node-resolve");
const { uglify } = require("rollup-plugin-uglify");
const babel = require("rollup-plugin-babel");
const alias = require("rollup-plugin-alias");
const cjs = require("rollup-plugin-commonjs");
const replace = require("rollup-plugin-replace");
// const lernaAliases = require("lerna-alias").rollup;

const chalk = require("chalk");
import builtInModules from "builtin-modules";
import Package from "../package";

// this makes sure nested imports of external packages are external
const makeExternalPredicate = externalArr => {
  if (externalArr.length === 0) {
    return () => false;
  }
  const pattern = new RegExp(`^(${externalArr.join("|")})($|/)`);
  return (id /*: string */) => pattern.test(id);
};

let unsafeRequire = require;

let pkgJsonsAllowedToFail = [
  // the package.json can't be found for this package on ci so for now,
  // we're just going to ignore it
  // TODO: investigate why it fails
  "nopt"
];

function getChildPeerDeps(
  finalPeerDeps: Array<string>,
  isUMD: boolean,
  depKeys: Array<string>,
  doneDeps: Array<string>
) {
  depKeys.filter(x => !doneDeps.includes(x)).forEach(key => {
    let pkgJson;
    try {
      pkgJson = unsafeRequire(key + "/package.json");
    } catch (err) {
      if (
        err.code === "MODULE_NOT_FOUND" &&
        pkgJsonsAllowedToFail.includes(key)
      ) {
        return;
      }
      throw err;
    }
    if (pkgJson.peerDependencies) {
      finalPeerDeps.push(...Object.keys(pkgJson.peerDependencies));
      getChildPeerDeps(
        finalPeerDeps,
        isUMD,
        Object.keys(pkgJson.peerDependencies),
        doneDeps
      );
    }
    // when we're building a UMD bundle, we're also bundling the dependencies so we need
    // to get the peerDependencies of dependencies
    if (pkgJson.dependencies && isUMD) {
      doneDeps.push(...Object.keys(pkgJson.dependencies));
      getChildPeerDeps(
        finalPeerDeps,
        isUMD,
        Object.keys(pkgJson.dependencies),
        doneDeps
      );
    }
  });
}

module.exports = (
  pkg: Package,
  entrypoint: string,
  {
    isUMD,
    isBrowser,
    isProd,
    shouldMinifyButStillBePretty
  }: {
    isUMD: boolean,
    isBrowser: boolean,
    isProd: boolean,
    shouldMinifyButStillBePretty: boolean
  }
) => {
  let external = [];
  if (pkg.peerDependencies) {
    external.push(...Object.keys(pkg.peerDependencies));
  }
  if (pkg.dependencies && !isUMD) {
    external.push(...Object.keys(pkg.dependencies));
  }
  getChildPeerDeps(
    external,
    isUMD,
    external.concat(
      isUMD && pkg.dependencies ? Object.keys(pkg.dependencies) : []
    ),
    []
  );
  if (!isBrowser) {
    external.push(...builtInModules);
  }
  // let packageAliases = lernaAliases();

  const config = {
    input: entrypoint,
    external: makeExternalPredicate(external),
    onwarn: (warning: *) => {
      switch (warning.code) {
        case "UNUSED_EXTERNAL_IMPORT": {
          break;
        }
        default: {
          console.error(chalk.red(warning.toString()));
          throw new Error(`There was an error compiling ${pkg.name}`);
        }
      }
    },
    plugins: [
      babel({
        presets: [
          [
            "@babel/env",
            {
              loose: true,
              modules: false,
              exclude: ["transform-typeof-symbol"]
            }
          ],
          "@babel/react",
          "@babel/flow"
        ],
        plugins: [
          "@babel/plugin-transform-flow-strip-types",
          require("./add-basic-constructor-to-react-component"),
          "codegen",
          ["@babel/proposal-class-properties", { loose: true }],
          require("./fix-dce-for-classes-with-statics"),
          [
            "@babel/plugin-proposal-object-rest-spread",
            { loose: true, useBuiltIns: !isUMD }
          ],
          !isUMD && "babel-plugin-transform-import-object-assign"
        ].filter(Boolean),
        configFile: false,
        babelrc: false
      }),
      cjs(),
      isBrowser &&
        replace({
          "typeof document": JSON.stringify("object"),
          "typeof window": JSON.stringify("object")
        }),
      // isUMD && alias(packageAliases),
      isUMD && resolve(),
      (isUMD || isProd) &&
        replace({
          "process.env.NODE_ENV": '"production"'
        }),

      isUMD && uglify(),
      shouldMinifyButStillBePretty &&
        uglify({
          mangle: false
        }),
      shouldMinifyButStillBePretty && prettier({ parser: "babylon" })
    ].filter(Boolean)
  };

  return config;
};