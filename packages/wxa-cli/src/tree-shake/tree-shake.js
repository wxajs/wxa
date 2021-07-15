const {dceDeclaration, log} = require('./util');
const generate = require('@babel/generator').default;

class TreeShake {
    // 根文件集
    roots = [];
    // 由 impoet->export 组成的链
    chains = {};
    // 没有被 import 的 export 节点集合
    noReferencedExports = [];
    constructor(roots) {
        this.roots = roots;
    }

    run() {
        this.roots.forEach((root) => {
            this.shake(root);
        });
    
        log('shook');
    
        this.roots.forEach((root) => {
            this.collectNotReferencedExports(root);
        });

        log('collected');
    
        this.remove();

        log('removed');
    
        let contents = {};
        this.roots.forEach((root) => {
            contents = {...contents, ...this.output(root)};
        });

        log('output');
        return contents;
    }

    shake(dep) {
        if (dep._shook) {
            return;
        }

        let {imports, exports, isRoot, src: depSrc} = dep;

        log('shake src', depSrc);

        let fileExportChain = [];
        this.chains[depSrc] = fileExportChain;

        // 从 import 语句开始，构建一条 import->export->export 链式关系
        let collectExportChain = (dep, childSrc, currentChain) => {
            if (currentChain.length) {
                let child = dep.children.find(
                    (child) => child.src === childSrc
                );
                let exportsArray = Object.entries(child.exports);
                let localIndex = exportsArray.findIndex(
                    ([src]) => src == child.src
                );
                let localExports = null;
                let externalExports = [...exportsArray];

                if (localIndex !== -1) {
                    localExports = externalExports.splice(localIndex, 1)[0];
                }

                let usedExports = {};
                let nextChain = [];

                let setCurrentChain = (chainNode, childName, path) => {
                    let childChainNode = {
                        name: childName,
                        path,
                        children: [],
                        parent: chainNode,
                        dep: child,
                    };
                    chainNode.children.push(childChainNode);
                    nextChain.push(childChainNode);
                    path.$chain = {
                        [childName]: childChainNode,
                    };
                };

                let getExportLocalName = (path, defaultName) => {
                    // 兼容 exports.x = 1 节点
                    if (path.$isCjsExport) {
                        return defaultName;
                    }

                    let local = path.node.local;
                    if (local) {
                        return local.name;
                    }

                    return '*';
                };

                let addUsedExport = (src, name, path) => {
                    usedExports[src] = usedExports[src] || {};

                    if (name) {
                        usedExports[src][name] = path;
                    }
                };

                let collect = (chainNode, path, src, defaultLocalName) => {
                    let localName = '';

                    if (defaultLocalName) {
                        localName = defaultLocalName;
                    } else {
                        localName = getExportLocalName(path);
                    }

                    // 对于导出其他文件模块的语句：export {a as aa} from ''
                    // 可以理解为通过这条语句到对应文件去寻找 a 模块
                    // 如果多次解析到这条语句，并且寻找的模块名一样，那每次后面的分析都是一样的
                    // 一般来说 export {a as aa} from '' 语句寻找的就是语句中定义的模块 a
                    // 但 export * from ''，寻找的模块名可能由父节点决定
                    if (path.$chain && path.$chain[localName]) {
                        chainNode.children.push(path.$chain[localName]);
                        return;
                    }

                    setCurrentChain(chainNode, localName, path);
                    addUsedExport(src, localName, path);
                };

                let importAllChainNode = currentChain.find(
                    (node) => node.name === '*'
                );

                if (importAllChainNode) {
                    let importDefaultChainNode = currentChain.find(
                        (node) => node.name === 'default'
                    );

                    let markedDefalut = false;
                    if (localExports) {
                        Object.entries(localExports[1]).forEach(
                            ([name, path]) => {
                                if (name === 'default') {
                                    if (importDefaultChainNode) {
                                        markedDefalut = true;
                                        setCurrentChain(
                                            importDefaultChainNode,
                                            'dafault',
                                            path
                                        );
                                    }
                                } else {
                                    let localName = getExportLocalName(
                                        path,
                                        name
                                    );
                                    setCurrentChain(
                                        importAllChainNode,
                                        localName,
                                        path
                                    );
                                }
                            }
                        );
                    }

                    externalExports.forEach(([src, exportInfo]) => {
                        Object.entries(exportInfo).forEach(([name, path]) => {
                            if (
                                name === 'default' &&
                                importDefaultChainNode &&
                                !markedDefalut
                            ) {
                                collect(importDefaultChainNode, path, src);
                            } else if (name !== 'default') {
                                collect(importAllChainNode, path, src);
                            }
                        });
                    });
                } else {
                    currentChain.forEach((chainNode) => {
                        let name = chainNode.name;
                        if (localExports) {
                            let path = localExports[1][name];

                            if (path) {
                                if (name === 'default') {
                                    setCurrentChain(chainNode, 'dafault', path);
                                } else {
                                    let localName = getExportLocalName(
                                        path,
                                        name
                                    );
                                    setCurrentChain(chainNode, localName, path);
                                }
                                return;
                            }
                        }

                        externalExports.forEach(([src, exportInfo]) => {
                            let path = exportInfo[name];

                            if (path) {
                                collect(chainNode, path, src);
                            }

                            path = exportInfo['*'];

                            if (path) {
                                collect(chainNode, path, src, name);
                            }
                        });
                    });
                }

                Object.entries(usedExports).forEach((src, value) => {
                    let childUsedNames = Object.keys(value);
                    let childChain = childUsedNames.map((n) => {
                        return nextChain.find(
                            (chainNode) => chainNode.name === n
                        );
                    });

                    collectExportChain(child, src, childChain);
                });
            }
        };

        Object.entries(imports).forEach(([src, value]) => {
            let currentChain = [];

            Object.entries(value).forEach(([name, path]) => {
                let chainNode = {
                    parent: null,
                    name,
                    path,
                    children: [],
                    dep,
                };
                fileExportChain.push(chainNode);
                currentChain.push(chainNode);
            });

            collectExportChain(dep, src, currentChain);
        });

        // 根节点的 export 语句默认全部保留
        // 所以还需要处理根节点的 export 语句（export {} from ''）
        if (isRoot) {
            Object.entries(exports).forEach(([src, exportInfo]) => {
                if (src !== dep.src) {
                    let currentChain = [];

                    Object.entries(exportInfo).forEach(([name, path]) => {
                        let chainNode = {
                            parent: null,
                            name,
                            path,
                            children: [],
                            dep,
                        };
                        fileExportChain.push(chainNode);
                        currentChain.push(chainNode);
                    });

                    collectExportChain(dep, src, currentChain);
                }
            });
        }

        let markExport = () => {
            let visitedChainNodes = [];

            let findLastChainNode = (chainNode) => {
                // 某个节点在链上出现过两次，这条链不会找到最终导出的模块
                if (visitedChainNodes.includes(chainNode)) {
                    return;
                }

                visitedChainNodes.push(chainNode);

                if (!chainNode.children.length) {
                    let exportPath = chainNode.path;

                    // 最后一个节点是文件内导出（不是 export a from '')
                    // 才算是找到最终导出的节点
                    if (exportPath.node && !exportPath.node.source) {
                        visitedChainNodes.forEach((visitedNode, index) => {
                            // 第一个节点是 import 节点或者 root 的 export 节点
                            // 跳过
                            if (index === 0) {
                                return;
                            }

                            let {path} = visitedNode;

                            // 这条链上的所有 export 节点的 $extReferences 属性添加 import 节点
                            // 表示它们被导入过
                            path.$extReferences.add(visitedChainNodes[0].path);
                        });
                    }
                } else {
                    chainNode.children.forEach((child) => {
                        findLastChainNode(child);
                    });
                }

                visitedChainNodes.pop();
            };

            fileExportChain.forEach((chainNode) => {
                findLastChainNode(chainNode);
            });
        };

        markExport();

        dep._shook = true;
        dep.children.forEach((child) => this.shake(child));
    }

    // 收集没有被导入过的 export 节点
    collectNotReferencedExports(dep) {
        if (dep._colletced) {
            return;
        }

        let {exports, src} = dep;

        log('collect src', src);

        Object.entries(exports).forEach(([src, value]) => {
            Object.entries(value).forEach(([name, path]) => {
                if (!path.$extReferences.size) {
                    this.noReferencedExports.push({path, dep, name});
                }
            });
        });

        dep._colletced = true;

        dep.children.forEach((child) =>
            this.collectNotReferencedExports(child)
        );
    }

    remove() {
        let visitedChainNodes = [];
        let removeExtReference = (chainNode, importPath) => {
            // 循环依赖
            if (visitedChainNodes.includes(chainNode)) {
                return;
            }

            visitedChainNodes.push(chainNode);
            chainNode.children.forEach((childNode) => {
                childNode.path.$extReferences.delete(importPath);

                if (childNode.path.$extReferences.size === 0) {
                    this.noReferencedExports.push({
                        path: childNode.path,
                        dep: childNode.dep,
                        name: childNode.name,
                    });
                }

                removeExtReference(childNode, importPath);
            });
            visitedChainNodes.pop();
        };

        for (let i = 0; i < this.noReferencedExports.length; i++) {
            const {path: exportPath, dep, name} = this.noReferencedExports[i];
            let {commonjs, topScope, src} = dep;

            if (exportPath.$isCjsExport) {
                log(src, name);
                commonjs.deleteCJSExport(name);
            } else {
                log(src, name);
                exportPath.remove();
            }

            let importPaths = dceDeclaration(topScope);
            // 如果删除了 import 节点
            // 对应链上的所有 export 节点都删除这个 import 节点
            if (importPaths.length) {
                let chain = this.chains[src];

                importPaths.forEach((importPath) => {
                    let chainNode = chain.find(
                        (chainNode) => chainNode.path === importPath
                    );

                    removeExtReference(chainNode, importPath);
                });
            }
        }
    }

    output(dep) {
        let contents = {};

        let run = (dep) => {
            let {ast, code, src} = dep;

            if (dep._output) {
                return;
            }

            const {code: outputCode} = generate(
                ast,
                {
                    decoratorsBeforeExport: true,
                },
                code
            );

            contents[src] = {
                code,
                formattedCode: outputCode,
                src,
            };

            dep._output = true;

            dep.children.forEach((child) => {
                run(child);
            });
        };

        run(dep);

        return contents;
    }
}

module.exports = {TreeShake};
