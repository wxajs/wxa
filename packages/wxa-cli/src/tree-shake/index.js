let fs = require('fs');
let path = require('path');
let mkdirp = require('mkdirp');
const {parse} = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

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

class Scope {
    constructor(options) {
        options = options || {};

        this.parent = options.parent;
        this.depth = this.parent ? this.parent.depth + 1 : 0;
        this.names = options.params || [];
        this.nodes = {};
        this.isBlockScope = !!options.block;
    }
    // 添加变量名
    // isBlockDeclaration 是否是块级声明：let const class import
    add(node, name, isBlockDeclaration) {
        if (!isBlockDeclaration && this.isBlockScope) {
            // it's a `var` or function declaration, and this
            // is a block scope, so we need to go up
            this.parent.add(node, name, isBlockDeclaration);
        } else {
            this.names.push(name);
            // 变量名可能重复，两个var声明同一变量
            if (this.nodes[name]) {
                this.nodes[name].push(node);
            } else {
                this.nodes[name] = [node];
            }
        }
    }

    contains(name) {
        return !!this.findDefiningScope(name);
    }

    findDefiningScope(name) {
        if (this.names.includes(name)) {
            return this;
        }

        if (this.parent) {
            return this.parent.findDefiningScope(name);
        }

        return null;
    }
}

class Graph {
    constructor(entrySrc) {
        this.entrySrc = entrySrc;
        this.root = this.analysis(entrySrc);
    }

    getAbsolutePath(baseSrc, relativeSrc) {
        return path.resolve(path.dirname(baseSrc), relativeSrc);
    }

    analysis(src) {
        let imports = {};
        let exports = {};
        let code = readFile(src);
        let ast = parse(code, {sourceType: 'unambiguous'});

        let scope = new Scope();
        function addToScope(node, attr, isBlockDeclaration = false) {
            let identifierNode = node[attr];

            if (t.isIdentifier(identifierNode)) {
                identifierNode._skip = true;
            }

            node._used = 0;
            scope.add(node, identifierNode.name, isBlockDeclaration);
        }

        traverse(ast, {
            enter: (path) => {
                let {node} = path;
                let childScope;
                switch (node.type) {
                    // 函数声明 function a(){}
                    case 'FunctionDeclaration':
                        childScope = new Scope({
                            parent: scope,
                            block: false,
                        });
                        addToScope(node, 'id', false);
                    // 箭头函数 ()=>{}
                    case 'ArrowFunctionExpression':
                    // 函数表达式 function(){}
                    case 'FunctionExpression':
                        childScope = new Scope({
                            parent: scope,
                            block: false,
                        });
                        break;
                    // 块级作用域{}
                    case 'BlockStatement':
                        childScope = new Scope({
                            parent: scope,
                            block: true,
                        });
                        break;
                    // 变量声明
                    case 'VariableDeclaration':
                        node.declarations.forEach((variableDeclarator) => {
                            if (node.kind === 'let' || node.kind === 'const') {
                                addToScope(variableDeclarator, 'id', true);
                            } else {
                                addToScope(variableDeclarator, 'id', false);
                            }
                        });
                        break;
                    // 类的声明
                    case 'ClassDeclaration':
                        addToScope(node, 'id', true);
                        break;
                    // import 的声明
                    case 'ImportDeclaration':
                        node.specifiers.forEach((specifier) => {
                            addToScope(specifier, 'local', true);
                        });

                        let depSrc = this.getAbsolutePath(
                            src,
                            node.source.value + '.js'
                        );
                        imports[depSrc] = imports[depSrc] || [];
                        imports[depSrc] = imports[depSrc].concat([
                            ...node.specifiers,
                        ]);
                        break;
                    // import 的声明
                    case 'ExportNamedDeclaration':
                        exports[src] = exports[src] || [];
                        exports[src] = imports[src].concat([
                            ...node.specifiers,
                        ]);
                        break;
                }

                if (childScope) {
                    node._scope = childScope;
                    scope = childScope;
                }
            },

            // 退出节点
            exit(path) {
                let {node} = path;
                if (node._scope) {
                    scope = scope.parent;
                }
            },
        });

        traverse(ast, {
            enter(path) {
                let {node} = path;

                if (node._scope) {
                    scope = node._scope;
                }

                // obj.x 类型的属性访问，不算对x变量的使用
                if (t.isMemberExpression(node) && !node.computed) {
                    path.skip();
                }

                // TODO，怎么才算变量已经使用
                if (t.isIdentifier(node) && !node._skip) {
                    let defineScope = scope.findDefiningScope(node.name);
                    if (defineScope) {
                        defineScope.nodes[node.name].forEach((node) => {
                            node._used = 1;
                        });
                    }
                }
            },
            // 退出节点
            exit(path) {
                let {node} = path;
                if (node._scope) {
                    scope = scope.parent;
                }
            },
        });

        console.log(src);
        console.log(imports);
        console.log(exports);

        let dep = {
            src,
            code,
            ast,
            imports,
            exports,
            children: [],
            scope,
        };

        Object.keys(dep.imports).forEach((childSrc, index) => {
            dep.children[index] = this.analysis(childSrc);
        });

        return dep;
    }
}

let entrySrc = path.resolve(__dirname, '../../example/index.js');
let graph = new Graph(entrySrc);
function run(dep) {
    let {ast, scope, code, src} = dep;

    traverse(ast, {
        enter(path) {
            let {node} = path;

            if (node._used === 0) {
                path.remove();
            }
        },
    });

    const output = generate(
        ast,
        {
            /* options */
        },
        code
    );

    writeFile(
        path.resolve(path.dirname(src), './shaking', path.basename(src)),
        output.code
    );

    dep.children.forEach((child) => {
        run(child);
    });
}

run(graph.root);

// function name(params) {
//     console.log(m);
// }

// name();