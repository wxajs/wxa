import path from 'path';

function getRegExp(str, flag) {
    return new RegExp(str.replace(/\\/g, '\\\\', flag));
}

// 字符编码数值对应的存储长度：
// UCS-2编码(16进制) UTF-8 字节流(二进制)
// 0000 - 007F       0xxxxxxx （1字节）
// 0080 - 07FF       110xxxxx 10xxxxxx （2字节）
// 0800 - FFFF       1110xxxx 10xxxxxx 10xxxxxx （3字节）
function getBytes(str) {
    let totalLength = 0;
    let charCode;
    for (let i = 0; i < str.length; i++) {
        charCode = str.charCodeAt(i);
        if (charCode < 0x007f) {
            totalLength++;
        } else if (0x0080 <= charCode && charCode <= 0x07ff) {
            totalLength += 2;
        } else if (0x0800 <= charCode && charCode <= 0xffff) {
            totalLength += 3;
        } else {
            totalLength += 4;
        }
    }
    return totalLength;
}

export default class SplitDeps {
    constructor({appConfigs, wxaConfigs, cwd, cmdOptions}) {
        this.cmdOptions = cmdOptions;
        this.wxaConfigs = wxaConfigs;
        this.config = wxaConfigs.optimization.splitDeps;
        this.NMReg = getRegExp(path.join(cwd, 'node_modules'));
        this.mainNodes = [];

        // 分包的依赖集（未被主包依赖）
        this.subPackagesDeps = new Map();
        // 分包的依赖，但最终会打包进主包
        this.subPackagesDepsInMain = {};
        this.mainDeps = new Set();

        let pkg = appConfigs.subpackages || appConfigs.subPackages;
        if (pkg) {
            // flattern pages array and remember the subpackage's root.
            this.subPages = pkg.reduce((prev, pkg) => {
                if (Array.isArray(pkg.pages)) {
                    let obj = {
                        reg: getRegExp(
                            '^' + path.join(wxaConfigs.context, pkg.root)
                        ),
                        outputReg: getRegExp(
                            '^' + path.join(wxaConfigs.output.path, pkg.root)
                        ),
                        path: path.join(wxaConfigs.context, pkg.root),
                        root: pkg.root,
                    };
                    prev.push(obj);
                    this.subPackagesDeps.set(obj.path, new Set());
                }

                return prev;
            }, []);
        } else {
            this.isNoSubPackage = true;
        }
    }

    run(indexedMap) {
        if (this.isNoSubPackage) return;

        if (!this.config.enable) {
            return;
        }

        let [src, root] =
            Array.from(indexedMap).find(([src, mdl]) => mdl.isROOT) || [];

        if (root == null) return;

        this.root = root;

        this.normalizeSrc(root);

        root.childNodes.forEach((node) => {
            let isSubPage = this.subPages.some((sub) => sub.reg.test(node.src));

            if (!isSubPage) {
                this.mainNodes.push(node);
            }
        });

        this.split();
    }

    split() {
        this.collectDeps();
        this.normalizeDeps();
        this.analysisDeps();
        this.filterDeps();
        this.moveDeps();
    }

    /**
     * 收集分包的依赖
     * subPackagesDeps 数据结构:
     *  {
     *    [分包路径]: 依赖数组
     *  }
     */
    collectDeps() {
        let traversal = (dep, pkg) => {
            dep.$visited = true;
            dep.childNodes.forEach((child) => {
                // 处理循环引用
                if (child.$visited) return;

                if (child.pret.isWXALib || this.isInMainPackage(child)) {
                    return;
                }

                // 抽象节点或是本身就是分包的文件
                // 继续遍历下一层
                if (child.isAbstract || pkg.reg.test(child.src)) {
                    traversal(child, pkg);
                    return;
                }

                // 分包的依赖项
                child.isSplit = true;
                this.subPackagesDeps.get(pkg.path).add(child);
                traversal(child, pkg);
            });

            dep.$visited = false;
        };
        // 从入口开始溯源
        this.root.childNodes.forEach((entryPoint) => {
            let pkg = this.subPages.find((sub) => sub.reg.test(entryPoint.src));
            if (pkg) {
                traversal(entryPoint, pkg);
            }
        });
    }

    /**
     * 格式化 subPackagesDeps：
     *  {
     *    [分包路径]: {
     *        [依赖路径]：{
     *            deps: 依赖数组 （组件有多个文件），
     *            references: 被多少个分包引用,
     *            size: 依赖大小（递归遍历子依赖，计算不在主包依赖大小之和）
     *        }
     *    }
     *  }
     */
    normalizeDeps() {
        // 当一个分包内依赖格式化完毕
        // 将依赖信息存储
        let normalizedDeps = {};

        let doNormalize = (deps) => {
            let subPackageInfo = {};

            deps.forEach((dep) => {
                let ext = path.extname(dep.src);
                if (ext === '.wxml') {
                    let src = this.removePathExt(dep.src);

                    // 先从缓存中读取依赖信息
                    // 这么做的目的是让同一依赖信息 depInfo 在不同分包下维持同一引用
                    let depInfo = normalizedDeps[src];
                    if (depInfo) {
                        subPackageInfo[src] = depInfo;
                        return;
                    }

                    let set = new Set();
                    set.add(dep);
                    subPackageInfo[src] = {
                        deps: set,
                    };
                }
            });

            deps.forEach((dep) => {
                let reference = Array.from(dep.reference);
                let ext = path.extname(dep.src);
                // 将组件的四个文件作为一个依赖整体
                if (reference.length === 1 && reference[0][1].isAbstract) {
                    let src = this.removePathExt(dep.src);

                    let depInfo = normalizedDeps[src];
                    if (depInfo) {
                        subPackageInfo[src] = depInfo;
                        return;
                    }

                    depInfo = subPackageInfo[src] || {deps: new Set()};
                    let set = depInfo.deps;
                    set.add(dep);
                    subPackageInfo[src] = depInfo;
                } else if (['.wxss', '.json', '.wxml', '.js'].includes(ext)) {
                    let src = this.removePathExt(dep.src);

                    let depInfo = normalizedDeps[src];
                    if (depInfo) {
                        subPackageInfo[src] = depInfo;
                        return;
                    }

                    if (subPackageInfo[src]) {
                        subPackageInfo[src].deps.add(dep);
                    } else {
                        subPackageInfo[dep.src] = {
                            deps: new Set().add(dep),
                        };
                    }
                } else {
                    let src = dep.src;

                    let depInfo = normalizedDeps[src];
                    if (depInfo) {
                        subPackageInfo[src] = depInfo;
                        return;
                    }

                    subPackageInfo[src] = {
                        deps: new Set().add(dep),
                    };
                }
            });

            normalizedDeps = {...normalizedDeps, ...subPackageInfo};
            return subPackageInfo;
        };

        let subPackagesDeps = new Map();
        this.subPackagesDeps.forEach((deps, subPackageSrc) => {
            subPackagesDeps.set(subPackageSrc, doNormalize(deps));
        });
        this.subPackagesDeps = subPackagesDeps;
    }

    analysisDeps() {
        this.subPackagesDeps.forEach((subPackageInfo) => {
            Object.keys(subPackageInfo).forEach((depSrc) => {
                let depInfo = subPackageInfo[depSrc];

                depInfo.children = depInfo.children || new Set();
                depInfo.parents = depInfo.parents || new Set();
                // 依赖信息 depInfo 之间的关系
                depInfo.deps.forEach((dep) => {
                    dep.childNodes.forEach((child) => {
                        let src = child.src;
                        let nSrc = this.removePathExt(src);

                        let childDepInfo =
                            subPackageInfo[src] || subPackageInfo[nSrc];
                        if (childDepInfo) {
                            childDepInfo.parents =
                                childDepInfo.parents || new Set();

                            depInfo.children.add(childDepInfo);
                            childDepInfo.parents.add(depInfo);
                        }
                    });
                });

                // 已经计算过大小
                // 不同分包下同一依赖的信息维持同一引用
                if (depInfo.references) {
                    depInfo.references++;
                    return;
                }

                depInfo.references = 1;
            });
        });
    }

    /**
     * 计算依赖大小，会递归遍历子节点
     */
    computeDepSize() {
        let compute = (deps) => {
            let size = 0;

            let run = (deps) => {
                deps.forEach((dep) => {
                    // 处理循环引用
                    if (dep.$t) {
                        return;
                    }
                    dep.$t = true;

                    if (!dep.isSplit) {
                        return;
                    }

                    size += dep.size;
                    run(dep.childNodes);
                });
            };

            function clean(deps) {
                deps.forEach((dep) => {
                    if (!dep.$t) {
                        return;
                    }
                    delete dep.$t;

                    clean(dep.childNodes);
                });
            }

            run(deps);
            clean(deps);

            return size;
        };

        this.subPackagesDeps.forEach((subPackageInfo) => {
            Object.keys(subPackageInfo).forEach((depSrc) => {
                let depInfo = subPackageInfo[depSrc];

                // 已经计算过大小
                // 不同分包下同一依赖的信息维持同一引用
                if (depInfo.size) {
                    return;
                }

                depInfo.size = compute(depInfo.deps);
            });
        });
    }

    /**
     * 过滤依赖，根据条件将 subPackagesDeps 中的依赖放入到 subPackagesDepsInMain
     */
    filterDeps() {
        // 如果要移动到主包
        // 那该dep且其所有子dep都需要被移动
        let moveToMain = (filter) => {
            let mark = (depInfo) => {
                if (depInfo.inMain) {
                    return;
                }

                depInfo.inMain = true;

                depInfo.children.forEach((childDepInfo) => {
                    mark(childDepInfo);
                });
            };

            this.subPackagesDeps.forEach((subPackageInfo) => {
                Object.keys(subPackageInfo).forEach((depSrc) => {
                    let depInfo = subPackageInfo[depSrc];
                    if (filter(depSrc, depInfo)) {
                        mark(depInfo);
                    }
                });
            });

            this.subPackagesDeps.forEach((subPackageInfo) => {
                Object.keys(subPackageInfo).forEach((depSrc) => {
                    let depInfo = subPackageInfo[depSrc];

                    if (depInfo.inMain) {
                        delete subPackageInfo[depSrc];
                        if (!this.subPackagesDepsInMain[depSrc]) {
                            this.subPackagesDepsInMain[depSrc] = depInfo;
                            depInfo.deps.forEach((dep) => {
                                delete dep.isSplit;
                            });
                        }
                    }
                });
            });
        };

        this.computeDepSize();

        let {enableLocalDep} = this.config;

        if (!enableLocalDep) {
            moveToMain((depSrc, depInfo) => {
                // 非npm的依赖放入主包
                return !this.NMReg.test(depSrc);
            });
        }

        let doFilter = (filter) => {
            let defaultFilter = {
                maxDeps: Number.MAX_SAFE_INTEGER,
                minDeps: 0,
                maxDepSize: Number.MAX_SAFE_INTEGER,
                minDepSize: 0,
            };
            let {maxDeps, minDeps, maxDepSize, minDepSize} = Object.assign(
                defaultFilter,
                filter
            );

            moveToMain((depSrc, depInfo) => {
                // 放在主包
                return (
                    depInfo.references > maxDeps ||
                    depInfo.references < minDeps ||
                    depInfo.size > maxDepSize ||
                    depInfo.size < minDepSize
                );
            });

            this.computeDepSize();
        };


        let {filter} = this.config;

        if (Array.isArray(filter)) {
            filter.forEach((item) => {
                doFilter(item);
            });
        } else {
            doFilter(filter);
        }
    }

    /**
     * 改变 subPackagesDeps 中依赖的输出路径
     * 一个依赖可能有多个输出路径，但它的输出只能是在各个分包或是主包中二选一
     */
    moveDeps() {
        // 储存每个分包下的，已经移动的依赖和其改变的父节点
        let movedDepAndChangedParent = new Map();
        let change = (dep, parent, pkg, allDeps) => {
            let {root} = pkg;
            let {outputPath: oldOutputPath} = dep.meta;
            let newOutputPath = '';
            let isNpmDep = this.NMReg.test(dep.src);

            // npm 的文件
            // 放到对应分包的npm目录下
            if (isNpmDep) {
                let subNpm = path.join(root, 'npm');
                newOutputPath = oldOutputPath.replace(
                    getRegExp(
                        '^' + path.join(this.wxaConfigs.output.path, 'npm')
                    ),
                    path.join(this.wxaConfigs.output.path, subNpm)
                );
            } else {
                // 主包的文件
                // 输出到对应分包下的_main目录下
                let subMain = path.join(root, '_main');
                newOutputPath = oldOutputPath.replace(
                    getRegExp('^' + this.wxaConfigs.output.path),
                    path.join(this.wxaConfigs.output.path, subMain)
                );
            }

            // 更改父节点引用该文件时的路径
            this.changePatnInCode(
                parent.referenceNode,
                parent.oldOutputPath,
                parent.newOutputPath,
                oldOutputPath,
                newOutputPath
            );

            dep.output.delete(oldOutputPath);
            dep.output.add(newOutputPath);

            // 每次移动dep到分包
            // 存储移动的dep和其改变的父节点
            let changedParents = movedDepAndChangedParent.get(dep) || new Set();
            changedParents.add(parent.referenceNode);
            movedDepAndChangedParent.set(dep, changedParents);

            // 更改引用子节点时的路径
            dep.childNodes.forEach((child) => {
                let trueChild = child;
                if (child.isAbstract) {
                    trueChild = Array.from(child.childNodes)[0][1];
                }

                // 子节点不会发生输出路径改变
                // 如果子节点会输出路径改变，那在接下来的遍历中，必然会遍历到该子节点，从而改变这个父节点引用子节点的路径
                if (!allDeps.includes(trueChild)) {
                    this.changePatnInCode(
                        dep,
                        oldOutputPath,
                        newOutputPath,
                        trueChild.meta.outputPath,
                        trueChild.meta.outputPath
                    );
                }
            });

            return {oldOutputPath, newOutputPath};
        };

        let start = (dep, pkg, allDeps) => {
            dep.node.$visited = true;

            dep.node.childNodes.forEach((child) => {
                // 循环引用
                if (child.$visited) {
                    return;
                }

                if (child.isAbstract) {
                    start(
                        {
                            oldOutputPath: dep.oldOutputPath,
                            newOutputPath: dep.newOutputPath,
                            node: child,
                            referenceNode: dep.node,
                        },
                        pkg,
                        allDeps
                    );
                    return;
                }

                // 依赖已经被移动且该依赖已经改变过父节点
                // 直接返回
                if (
                    movedDepAndChangedParent.has(child) &&
                    movedDepAndChangedParent.get(child).has(dep.referenceNode)
                ) {
                    return;
                }

                if (allDeps.includes(child)) {
                    let {oldOutputPath, newOutputPath} = change(
                        child,
                        dep,
                        pkg,
                        allDeps
                    );

                    start(
                        {
                            oldOutputPath,
                            newOutputPath,
                            node: child,
                            referenceNode: child,
                        },
                        pkg,
                        allDeps
                    );
                }
            });

            delete dep.node.$visited;
        };

        this.subPackagesDeps.forEach((subPackageInfo, subPackageSrc) => {
            let pkg = this.subPages.find((sub) => sub.path === subPackageSrc);
            let allDeps = this.getSubPackageDeps(subPackageInfo);
            movedDepAndChangedParent = new Map();

            // 遍历当前分包
            Object.keys(subPackageInfo).forEach((depSrc) => {
                let depInfo = subPackageInfo[depSrc];

                depInfo.deps.forEach((dep) => {
                    let allParents = Array.from(dep.reference.values());
                    let parents = [];

                    allParents.forEach((parent) => {
                        if (parent.isAbstract) {
                            let pParents = Array.from(
                                parent.reference.values()
                            );
                            pParents.forEach((pParent) => {
                                if (pkg.reg.test(pParent.src)) {
                                    parents.push(pParent);
                                }
                            });
                            return;
                        }

                        if (pkg.reg.test(parent.src)) {
                            parents.push(parent);
                        }
                    });

                    // 在当前分包内没有找到parent
                    // 那表示该依赖并不是被当前分包直接引用
                    // 那一定能在之后的遍历中找到一个父节点被当前分包直接引用
                    // 对那个父节点所形成的依赖子树进行output路径修改
                    if (!parents.length) {
                        return;
                    }

                    parents.forEach((parent) => {
                        start(
                            {
                                node: parent,
                                referenceNode: parent,
                                oldOutputPath: parent.meta.outputPath,
                                newOutputPath: parent.meta.outputPath,
                            },
                            pkg,
                            allDeps
                        );
                    });
                });
            });
        });
    }

    // 格式化路径
    normalizeSrc(node) {
        function run(node) {
            // 处理循环引用
            if (node.$t) {
                return;
            }

            node.$t = true;
            node.src && (node.src = path.normalize(node.src));

            node.childNodes.forEach((child) => run(child));
        }

        function clean(node) {
            if (!node.$t) {
                return;
            }

            delete node.$t;
            node.childNodes.forEach((child) => clean(child));
        }

        run(node);
        clean(node);
    }

    getSubPackageDeps(subPackageInfo) {
        let allDeps = [];
        Object.keys(subPackageInfo).forEach((depSrc) => {
            let depInfo = subPackageInfo[depSrc];
            allDeps = [...allDeps, ...depInfo.deps];
        });
        return allDeps;
    }

    // 是否被主包依赖
    isInMainPackage(child) {
        let run = (child) => {
            // 处理循环引用
            if (child.$t) {
                return;
            }

            child.$t = true;

            let refs = Array.from(child.reference);

            // 是否被主包页面直接依赖
            let isMainDependent = refs.some(([src, mdl]) => {
                return this.mainNodes.some((node) => node.src === mdl.src);
            });

            if (isMainDependent) {
                return true;
            }

            // 如果不在主包，检查其父节点（依赖其的文件）
            if (!isMainDependent) {
                for (let i = 0; i < refs.length; i++) {
                    let parentNode = refs[i][1];
                    if (!parentNode.isROOT) {
                        if (run(parentNode)) {
                            return true;
                        }
                    }
                }
            }

            return false;
        };

        let clean = (child) => {
            if (!child.$t) {
                return;
            }

            delete child.$t;

            child.reference.forEach((parent) => {
                clean(parent);
            });
        };

        let res = run(child);
        clean(child);

        return res;
    }

    changePatnInCode(node, oldPath, newPath, depOldPath, depNewPath) {
        let originResolvedPath = './' + this.getResolved(oldPath, depOldPath);
        let newResolvedPath = './' + this.getResolved(newPath, depNewPath);

        if (node.kind === 'json') {
            originResolvedPath =
                './' + this.getPathWithoutExtension(originResolvedPath);
            newResolvedPath =
                './' + this.getPathWithoutExtension(newResolvedPath);
        }

        // 在默认输出下，一个节点只会输出一个文件
        // 但这里一个节点会输出多个文件，多个文件不同目录
        // 那么它们引用子文件时，所写路径也会不一样
        // 所以要存在多个code（文件内容），与不同输出路径对应
        let codes = node.codes || new Map();
        let code = codes.get(newPath) || node.code;

        code = code.replace(
            getRegExp('["\']' + originResolvedPath + '["\']', 'gm'),
            '"' + newResolvedPath + '"'
        );
        codes.set(newPath, code);
        node.codes = codes;
    }

    // 去掉路径最后的文件类型后缀
    getPathWithoutExtension(pathString) {
        return this.removePathExt(pathString).replace(/\\/g, '/');
    }

    removePathExt(pathString) {
        let opath = path.parse(pathString);

        // path.join 会丢失路径前的'./'字符
        return path.join(opath.dir, opath.name);
    }

    getResolved(from, to) {
        return path.relative(path.dirname(from), to).replace(/\\/g, '/');
    }

    // 检查一个依赖被多少分包依赖
    // 没使用到, 但可以直接检查一个依赖
    checkReferenceSize(dep) {
        let run = (dep) => {
            if (dep.isROOT) {
                return true;
            }

            // 处理循环引用
            if (dep.$t) {
                return true;
            }

            dep.$t = true;

            let from = new Set();

            dep.reference.forEach((mdl) => {
                let m = this.subPages.find((sub) => sub.reg.test(mdl.src));
                if (m) from.add(m.path);
            });

            let nums = from.size;

            if (nums < this.config.maxDeps) {
                return Array.from(dep.reference.values()).every((parent) =>
                    run(parent)
                );
            }

            return false;
        };

        let clean = (dep) => {
            if (!dep.$t) {
                return;
            }

            delete dep.$t;

            dep.reference.forEach((parent) => {
                clean(parent);
            });
        };

        let res = run(dep);
        clean(dep);

        return res;
    }
}
