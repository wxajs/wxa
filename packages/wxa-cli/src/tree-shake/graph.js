const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const {
    readFile,
    resolveDepSrc,
    parseESCode,
    dceDeclaration,
} = require('./util');
let config = require('./config');
let {TransformCommonJs} = require('./tansform-commonJS');

class Graph {
    constructor(entries) {
        this.entries = config.entry;
        this.analysis();
    }

    getAbsolutePath(fileSrc, depSrc) {
        let s = resolveDepSrc({
            fileSrc,
            depSrc,
            ...config.resolveSrc,
        });

        if (!s.endsWith('.js')) {
            s += '.js';
        }

        return s;
    }

    getExpSrc(node, src) {
        let expSrc = '';

        if (node.source) {
            expSrc = this.getAbsolutePath(src, node.source.value);
        } else {
            expSrc = src;
        }

        return expSrc;
    }

    collectImport(src) {
        let imports = {};
        let store = (name, path, node) => {
            let impSrc = this.getAbsolutePath(src, node.source.value);
            imports[impSrc] = imports[impSrc] || {};
            if (name === '' || path === '') {
                return;
            }
            imports[impSrc][name] = path;
        };

        let visitor = {
            ImportDeclaration: {
                enter: (path) => {
                    let {node} = path;
                    let specifierPaths = path.get('specifiers');
                    if (specifierPaths && specifierPaths.length) {
                        specifierPaths.forEach((specifierPath) => {
                            let specifierNode = specifierPath.node;
                            let name =
                                specifierNode.imported &&
                                specifierNode.imported.name;

                            if (!name) {
                                if (
                                    specifierNode.type ===
                                    'ImportDefaultSpecifier'
                                ) {
                                    name = 'default';
                                } else if (
                                    specifierNode.type ===
                                    'ImportNamespaceSpecifier'
                                ) {
                                    name = '*';
                                }
                            }
                            store(name, specifierPath, node);
                        });
                    } else {
                        // import './a'
                        store('', '', node);
                    }
                },
            },
        };

        return {visitor, imports};
    }

    collectExport(src, isRoot) {
        let exports = {};

        let store = (name, path, node) => {
            if (isRoot) {
                path.$extReferences = new Set().add('root');
            } else {
                path.$extReferences = new Set();
            }
            let expSrc = this.getExpSrc(node, src);
            exports[expSrc] = exports[expSrc] || {};
            exports[expSrc][name] = path;
        };

        let storeSpecifiers = (path, node) => {
            let specifierPaths = path.get('specifiers');
            specifierPaths.forEach((specifierPath) => {
                let name = specifierPath.node.exported.name;
                store(name, specifierPath, node);
            });
        };

        let transformExportDeclarationToSpecifiers = (path) => {
            let declarationPath = path.get('declaration');
            let declarationNode = declarationPath.node;
            let specifiers = [];

            if (declarationNode.type === 'FunctionDeclaration') {
                let name = declarationNode.id.name;
                specifiers.push(
                    t.exportSpecifier(t.identifier(name), t.identifier(name))
                );
            } else if (declarationNode.type === 'VariableDeclaration') {
                let declarationPaths = declarationPath.get('declarations');
                declarationPaths.forEach((variableDeclaratorPath) => {
                    let name = variableDeclaratorPath.node.id.name;
                    specifiers.push(
                        t.exportSpecifier(
                            t.identifier(name),
                            t.identifier(name)
                        )
                    );
                });
            } else if (declarationNode.type === 'ClassDeclaration') {
                let name = declarationNode.id.name;
                specifiers.push(
                    t.exportSpecifier(t.identifier(name), t.identifier(name))
                );
            }

            return {specifiers, declarationPath};
        };

        let visitor = {
            ExportNamedDeclaration: {
                enter: (path) => {
                    let {node} = path;

                    if (node.specifiers && node.specifiers.length) {
                        storeSpecifiers(path, node);
                    } else {
                        let {specifiers, declarationPath} =
                            transformExportDeclarationToSpecifiers(path);

                        let newDeclarationPath = path.insertBefore(
                            declarationPath.node
                        )[0];
                        let exportNamedDeclaration = t.exportNamedDeclaration(
                            null,
                            specifiers
                        );
                        let newExportPath = path.insertAfter(
                            exportNamedDeclaration
                        )[0];
                        // 删除声明节点会同时删除相应binding
                        path.remove();
                        // 注册binding
                        // 注册binding是根据path来注册
                        // path.scope.registerBinding(declarationPath.node.kind || 'hoisted', newDeclarationPath);
                        // 注册binding，并不会自动更新相应binding的referencePaths等信息，调用crawl更新
                        // path.scope.crawl();

                        storeSpecifiers(newExportPath, node);
                    }
                },
            },
            ExportDefaultDeclaration: {
                enter: (path) => {
                    let {node} = path;
                    let declarationNode = node.declaration;
                    let exportPath = path;

                    // TODO，未处理 export default a=1 这类表达式
                    // 类似于export default function mm(){}
                    // 单独声明mm，并export default mm
                    if (declarationNode.id && declarationNode.id.name) {
                        let newDeclarationPath =
                            path.insertBefore(declarationNode)[0];
                        let exportDefaultNode = t.exportDefaultDeclaration(
                            t.identifier(declarationNode.id.name)
                        );
                        exportPath = path.insertAfter(exportDefaultNode)[0];
                        path.remove();
                        // 注册binding
                        // path.scope.registerBinding( declarationNode.kind || 'hoisted', newDeclarationPath);
                        // path.scope.crawl();
                    }

                    store('default', exportPath, node);
                },
            },
            ExportAllDeclaration: {
                enter: (path) => {
                    let {node} = path;
                    store('*', path, node);
                },
            },
        };

        return {visitor, exports};
    }

    dceDeclaration(ast) {
        let currentScope = null;
        traverse(ast, {
            enter: (path) => {
                let scope = path.scope;
                if (currentScope !== scope) {
                    currentScope = scope;
                    dceDeclaration(currentScope);
                }
            },
        });
    }

    analysis() {
        let analyzedFile = {};

        let doAnalysis = (entry, isRoot) => {
            let src = '';
            let content = '';

            if (typeof entry === 'string') {
                src = entry;
            } else {
                src = entry.src;
                content = entry.content;
            }

            // if (src.endsWith('user.js')) {
            //     console.log('src', src);
            //     this.debug = true;
            // }

            if (analyzedFile[src]) {
                return analyzedFile[src];
            }

            console.log('graph', src);

            let code = content || readFile(src);
            let ast = parseESCode(code);

            this.dceDeclaration(ast);

            let topScope = null;

            let transformCommonJs = new TransformCommonJs({src, code, ast});

            let {visitor: exportVisitor, exports} = this.collectExport(
                src,
                isRoot
            );
            let {visitor: importVisitor, imports} = this.collectImport(src);

            traverse(ast, {
                Program: {
                    enter: (path) => {
                        topScope = path.scope;
                    },
                },
                ...exportVisitor,
                ...importVisitor,
            });

            // console.log(src);
            // console.log('imports', imports);
            // console.log('exports', exports);

            // import * 和 export * 不包括default
            // export * from '' 和 export 本文件冲突，export 本文件优先级更高
            // export * from '' 互相冲突，后export * from '' 优先
            // export {} from ''， 从其他文件导出，导出的变量无法在本文件使用
            // export default function(){}，导出的函数没有name时，不能在本文件使用
            // 不存在语法 export default let a =1
            /**
             * imports: {
             *      [路径]: {
             *          [name]: ImportSpecifier,
             *          default: ImportDefaultSpecifier,
             *          *: ImportNamespaceSpecifier
             *      }
             * }
             *
             * exports: {
             *      [本文件路径]: {
             *          // export default function(){} | export default{} | export {a as default} | export default a
             *          default: ExportDefaultDeclaration,
             *          // export {a as aaa,b,c}
             *          [name]: ExportSpecifier
             *      },
             *      [其他路径]: {
             *          // export {a as aaa,b,c} from '' | export * as all from ''
             *          [name]: ExportSpecifier
             *          // export {default} from '' | export {a as default} from '' | export * as default from ''
             *          default: ExportSpecifier,
             *          // export * from ''
             *          *: ExportAllDeclaration
             *      },
             * }
             */

            if (transformCommonJs) { 
                transformCommonJs.state.cjsRequireModules.forEach(
                    (names, requireSrc) => {
                        let abSrc = this.getAbsolutePath(src, requireSrc);

                        imports[abSrc] = imports[abSrc] || {};
                        Array.from(names).forEach((name) => {
                            if (name === 'default') {
                                imports[abSrc].default = 'custom_import_name';
                                imports[abSrc]['*'] = 'custom_import_name';
                                return;
                            }

                            imports[abSrc][name] = 'custom_import_name';
                        });
                    }
                );

                transformCommonJs.state.cjsExportModules.forEach(
                    (path, name) => {
                        exports[src] = exports[src] || {};
                        exports[src][name] = path;
                        path.$isCjsExport = true;
                        if (isRoot) {
                            path.$extReferences = new Set().add('root');
                        } else {
                            path.$extReferences = new Set();
                        }

                        // console.log('s：', name, path.toString());
                    }
                );
            }

            let dep = {
                src,
                code,
                ast,
                imports,
                exports,
                children: [],
                topScope,
                isRoot,
                transformCommonJs,
            };

            // const generate = require('@babel/generator').default;
            // const {writeFile} = require('./util');
            // let path = require('path');
            // const {code: outputCode} = generate(
            //     ast,
            //     {
            //         /* options */
            //         decoratorsBeforeExport: true,
            //     },
            //     code
            // );
            // writeFile(
            //     path.resolve(
            //         path.dirname(src),
            //         './shaking',
            //         path.basename(src)
            //     ),
            //     outputCode
            // );

            analyzedFile[src] = dep;

            Object.keys(dep.imports).forEach((childSrc, index) => {
                dep.children.push(doAnalysis(childSrc));
            });

            // export {} from './a' a 文件也是子节点
            Object.keys(dep.exports).forEach((childSrc) => {
                if (childSrc !== src) {
                    dep.children.push(doAnalysis(childSrc));
                }
            });

            return dep;
        };

        this.roots = this.entries.map((entry) => {
            return doAnalysis(entry, true);
        });
    }
}

module.exports = {
    Graph,
};
