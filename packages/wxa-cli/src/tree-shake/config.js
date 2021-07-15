module.exports = {
    // {
    //    src: '', // 路径
    //    content: '', // 文件内容（可选）
    // },
    entry: [],
    resolveSrc: {
        // '/a/b/c'，绝对路径根目录
        // 例如src, '/a/b/c' 转换为 /src/a/b/b
        root: 'src',
        // {'@': 'src'}，路径别名
        alias: {},
        npm: 'node_modules',
    },
    commonJS: {
        enable: false,
        // 无法追踪动态引入的模块
        // 如果有模块被动态引入，需要在这里设置该模块文件路径
        // 将跳过对该文件的 tree shake
        dynamicRequireTargets: [],
        // 设置 exports 上的哪些属性不会被转换为 esm
        // 默认值有 '__esModule'
        ingoreKeys: ['__esModule'],
    },
    parseOptions: {
        plugins: [
            ['decorators', {decoratorsBeforeExport: true}],
            'classProperties',
            'exportNamespaceFrom',
            'exportDefaultFrom',
            'objectRestSpread',
        ],
        sourceType: 'unambiguous',
    },
    generateOptions: {
        decoratorsBeforeExport: true,
    },
    debug: false,
};
