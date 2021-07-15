let fs = require('fs');
let path = require('path');
let mkdirp = require('mkdirp');
const {parse} = require('@babel/parser');
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
let findRoot = require('find-root');
let config = require('./config');

function readFile(p) {
    let rst = '';
    p = typeof p === 'object' ? path.join(p.dir, p.base) : p;
    try {
        rst = fs.readFileSync(p, 'utf-8');
    } catch (e) {
        rst = null;
    }

    return rst;
}

function writeFile(p, data) {
    let opath = typeof p === 'string' ? path.parse(p) : p;
    mkdirp.sync(opath.dir);
    fs.writeFileSync(p, data);
}

function isFile(p) {
    p = typeof p === 'object' ? path.join(p.dir, p.base) : p;
    if (!fs.existsSync(p)) return false;
    return fs.statSync(p).isFile();
}

function isDir(p) {
    if (!fs.existsSync(p)) {
        return false;
    }

    return fs.statSync(p).isDirectory();
}

function getPkgConfig(npmSrc, lib) {
    let uri = path.join(npmSrc, lib);
    let location = findRoot(uri);
    let content = readFile(path.join(location, 'package.json'));
    try {
        content = JSON.parse(content);
    } catch (e) {
        content = null;
    }

    return content;
}

/**
 * 
 * @description 将import路径解析为绝对路径
 * @example
 *  resolveDepSrc({
        fileSrc: path.join(process.cwd(), './src/a.js'),
        depSrc: '@/b',
        root: 'src',
        alias: {
            '@': path.join(process.cwd(), '/src/xxx'),
        },
    })
 * @param {string} fileSrc 文件路径
 * @param {string} depSrc impot 引入的路径（"./a", "a", "@/a", "/a"）
 * @param {string} root depsrc 为绝对路径（例如：/a）时相对的目录
 * @param {string} alias 路径别名，例如：{'@': 'src'}
 * @param {string} npm npm 目录，例如：node_modules
 * @return {string} 依赖的绝对路径
 */
function resolveDepSrc({fileSrc, depSrc, root, alias, npm}) {
    let cwd = process.cwd();

    let getFileSrc = (src) => {
        if (isDir(src)) {
            return path.join(src, 'index.js');
        }

        if (!src.endsWith('.js')) {
            return src + '.js';
        }

        return src;
    };

    if (alias) {
        let aliasNames = Object.keys(alias);
        let absoluteSrc = '';
        let matched = aliasNames.some((aliasName) => {
            if (depSrc.startsWith(aliasName + '/')) {
                let aliasSrc = alias[aliasName];

                absoluteSrc = path.resolve(
                    cwd,
                    aliasSrc,
                    depSrc.replace(aliasName, '.')
                );
                return true;
            }
        });

        if (matched) {
            return getFileSrc(absoluteSrc);
        }
    }

    if (depSrc.startsWith('/')) {
        return getFileSrc(path.resolve(cwd, root, depSrc.replace('/', '')));
    }

    if (depSrc.startsWith('./') || depSrc.startsWith('../')) {
        let fileDir = path.dirname(fileSrc);
        return getFileSrc(path.resolve(fileDir, depSrc));
    }

    let npmSrc = path.join(cwd, npm);
    let absoluteSrc = path.join(npmSrc, depSrc);

    if (!absoluteSrc.endsWith('.js')) {
        absoluteSrc += '.js';
    }

    if (isFile(absoluteSrc)) {
        return absoluteSrc;
    }

    let pkg = getPkgConfig(npmSrc, depSrc);

    if (!pkg) {
        throw new Error('找不到模块' + depSrc);
    }

    let main = pkg.main || 'index.js';
    // 优先使用依赖的 browser 版本
    if (pkg.browser && typeof pkg.browser === 'string') {
        main = pkg.browser;
    }

    return getFileSrc(path.join(npmSrc, depSrc, main));
}

function parseESCode(code) {
    return parse(code, config.parseOptions);
}

function isChildNode(parent, child) {
    if (parent === child) {
        return true;
    }

    let is = false;

    traverse(parent, {
        noScope: true,
        enter(path) {
            let {node} = path;
            if (node === child) {
                is = true;
                path.stop();
            }
        },
    });

    return is;
}

// 删除 scope 下未引用的 binding
function dceDeclaration(scope) {
    let importPaths = [];

    let doDce = (scope) => {
        let hasRemoved = false;

        // 删除节点并不会自动更新相关binding的referenced等信息
        // 这里是重新收集bindings信息
        scope.crawl();

        let removeObjectPattern = (binding) => {
            let proPath = null;

            traverse(binding.path.node, {
                noScope: true,
                ObjectProperty: {
                    enter: (path) => {
                        if (path.node.value === binding.identifier) {
                            proPath = path;
                            path.stop();
                        }
                    },
                },
            });

            return proPath;
        };

        let remove = (name, scope, binding) => {
            let removedPath = binding.path;
            let bindingPath = binding.path;

            if (
                t.isImportDefaultSpecifier(bindingPath) ||
                t.isImportNamespaceSpecifier(bindingPath) ||
                t.isImportSpecifier(bindingPath)
            ) {
                importPaths.push(bindingPath);
            }

            // let {x: x1} = {x: 1, y2: 2};
            if (t.isVariableDeclarator(bindingPath)) {
                let id = bindingPath.node.id;

                if (t.isObjectPattern(id)) {
                    removedPath = removeObjectPattern(binding) || removedPath;
                }
            }

            removedPath.remove();
            scope.removeOwnBinding(name);
            hasRemoved = true;
        };

        Object.entries(scope.bindings).forEach(([name, binding]) => {
            if (binding.referenced) {
                return;
            }

            let bindingPath = binding.path;

            // 类似于let a = function ff(){}
            // ff 是函数内部作用域的binding，ff不应该被删除
            // if (t.isFunctionExpression(bindingPath)) {
            //     return;
            // }

            // // try...catch(e)，e没访问到时不该删除整个catch语句
            // if (t.isCatchClause(bindingPath)) {
            //     return;
            // }

            // // function(a, b) {};
            // // let t = function({dataset: {name, opts={}}}, [asq, ttqw]) {};
            // // 函数的参数
            // if (
            //     t.isFunctionExpression(bindingPath.parentPath) ||
            //     t.isFunctionDeclaration(bindingPath.parentPath)
            // ) {
            //     return;
            // }

            // //  let [zz, xx, cc] = [1, 2, 3];
            // //  let {x: x1} = {x: 1, y2: 2};
            // if (
            //     t.isVariableDeclarator(bindingPath) &&
            //     t.isArrayPattern(bindingPath.node.id)
            // ) {
            //     return;
            // }

            // // 未知
            // if (t.isArrayPattern(bindingPath)) {
            //     return;
            // }

            if (
                // 过滤 let [zz, xx, cc] = [1, 2, 3];
                // 变量声明语句可能有副作用，不能简单去除
                // 例如：
                // let a = obj.x，obj.x 可能有访问器属性。
                // let a = b = 1 连等
                // let a = fn() 非纯函数运行
                // 先处理为 init 为 identifier、函数、class、Literals 时，可以删除
                (t.isVariableDeclarator(bindingPath) &&
                    !t.isArrayPattern(bindingPath.node.id) &&
                    (t.isIdentifier(bindingPath.node.init) ||
                        t.isLiteral(bindingPath.node.init) ||
                        t.isArrowFunctionExpression(bindingPath.node.init) ||
                        t.isFunctionExpression(bindingPath.node.init) ||
                        t.isClassExpression(bindingPath.node.init))) ||
                t.isClassDeclaration(bindingPath) ||
                t.isFunctionDeclaration(bindingPath) ||
                t.isImportDefaultSpecifier(bindingPath) ||
                t.isImportNamespaceSpecifier(bindingPath) ||
                t.isImportSpecifier(bindingPath)
            ) {
                remove(name, scope, binding);
            }
        });

        // 处理声明之间循环引用
        // 当一个声明未被使用时，那该声明所引用的其他声明不算真正使用
        if (hasRemoved) {
            doDce(scope);
        }
    };

    doDce(scope);

    return importPaths;
}

function unique(ary) {
    return [...new Set(ary)];
}

function log(...params) {
    config.debug && log(...params);
}

module.exports = {
    readFile,
    writeFile,
    resolveDepSrc,
    parseESCode,
    dceDeclaration,
    isChildNode,
    unique,
    log,
};
