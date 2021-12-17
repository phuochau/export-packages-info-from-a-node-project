require('dotenv').config()
const _ = require('lodash')
const path = require('path')
const fs = require('fs')
const inquirer = require('inquirer')
const Axios = require('axios')
const moment = require('moment')
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const axios = Axios.create({
  baseURL: 'https://api.github.com/',
  headers: {
    Accept: 'application/vnd.github.v3+json',
    'Authorization': `token ${process.env.GITHUB_PERSONAL_TOKEN}` 
  }
})

const OPTION_DEPENDENCIES = 'Only dependencies'
const OPTION_DEV_DEPENDENCIES = 'Only devDependencies'
const OPTION_BOTH = 'Both'
const YEAR_VARS = ['[yyyy]', '[year]']
const OWNER_VARS = ['[name of copyright owner]', '[fullname]']

function replaceVarByValue(origin, searches, newString) {
  let final = origin
  for (let i = 0; i < searches.length; i++) {
    final = final.replace(searches[i], newString)
  }
  return final
}

async function getLicenseLink(link, name = '') {
  try {
    link = link || `https://api.github.com/licenses/${name.toLowerCase()}`
    const res = await axios.get(link)

    return _.get(res, 'data.html_url')
  } catch (e) {
    return ''
  }
}

async function findGithubLink(packageInfo, packageName) {
  let repoLink = packageInfo.repository || packageInfo.homepage
  if (!repoLink) {
    const answers = await inquirer.prompt([
      {
        name: 'repoLink',
        type: 'input',
        message: `Can't find the Github repository of the package: ${packageName}. Please copy the Github link and input here`
      },
    ])

    repoLink = answers.repoLink
  }

  if (typeof repoLink === 'object' && repoLink.url) {
    repoLink = repoLink.url
  }
  repoLink = repoLink.replace('https://github.com/', '')
  repoLink = repoLink.replace('http://github.com/', '')
  repoLink = repoLink.replace('git+ssh://git@github.com:', '')
  repoLink = repoLink.replace('git+ssh://git@github.com/', '')
  repoLink = repoLink.replace('git@github.com:', '')
  repoLink = repoLink.replace('git://github.com/', '')
  repoLink = repoLink.replace('github.com/', '')
  repoLink = repoLink.replace('.git', '')
  repoLink = repoLink.replace('git+', '')
  repoLink = repoLink.replace(/#.*/g, '')
  repoLink = repoLink.replace(/\?.*/g, '')
  
  // get only 2 first members of link
  repoLink = repoLink.split('/').slice(0, 2).join('/')
  return repoLink
}

function getRepoInfo(uri) {
  return axios.get(`repos/${uri}`).then(res => res.data)
}

function getUserInfo(username) {
  return axios.get(`users/${username}`).then(res => res.data)
}

function getLicenseInfo(licenseId) {
  return axios.get(`licenses/${licenseId}`).then(res => res.data)
}

async function getLicenseDescription(licenseInfo, repoInfo) {
  // Fetch from LICENSE file at the root of repository or build the content by https://choosealicense.com/
  let licenseDescription = null
  try {
    let repoLicenseFileContent = await axios.get(`repos/${_.get(repoInfo, 'full_name')}/contents/LICENSE`).then(res => res.data)
    if (repoLicenseFileContent) {
      repoLicenseFileContent = await Axios.get(repoLicenseFileContent.download_url).then(res => res.data)
      if (repoLicenseFileContent) {
        licenseDescription = repoLicenseFileContent
      }
    }
  } catch (e) {
  }

  if (!licenseDescription) {
    licenseDescription = _.get(licenseInfo, 'body')

    const createdYear = moment(_.get(repoInfo, 'created_at'), '').year()
    const authorUsername = _.get(repoInfo, 'owner.login')
    const authorInfo = await getUserInfo(authorUsername)
    const authorName = _.get(authorInfo, 'name') || authorUsername
    
    // replace by year and full name
    licenseDescription = replaceVarByValue(licenseDescription, YEAR_VARS, createdYear.toString())
    licenseDescription = replaceVarByValue(licenseDescription, OWNER_VARS, authorName)
  }
  // beautify the description
  licenseDescription = licenseDescription.replace(/\n\n/g, '<br>')
  licenseDescription = licenseDescription.replace(/\n/g, ' ')
  licenseDescription = licenseDescription.replace(/<br>/g, '\n\n')
  licenseDescription = licenseDescription.trim()

  return licenseDescription
}

function readModulePackageJson(rootFolderPath, packageName) {
  const jsonPath = path.join(rootFolderPath, 'node_modules', packageName, 'package.json')
  const content = fs.readFileSync(jsonPath)
  return JSON.parse(content)
}

async function writePropertiesToFile(rootFolderPath, dependencies, exportPath) {
  try {
    const csvWriter = createCsvWriter({
      path: `${exportPath}.csv`,
      header: [
        {id: 'no', title: 'No'},
        {id: 'name', title: 'Name'},
        {id: 'version', title: 'Version'},
        {id: 'license_name', title: 'License Name'},
        {id: 'license_link', title: 'License Link'},
      ]
    });
    
    const data = []
    let i = 1
  
    for (const key in dependencies) {
      const name = key
      const version = dependencies[key]
      const packageInfo = readModulePackageJson(rootFolderPath, name)
      const repoLink = await findGithubLink(packageInfo, name)

      let repoInfo = null
      let licenseInfo = null
      let licenseKey = ''
      let licenseName = packageInfo.license
      let licenseLink = ''
      let licenseDescription = ''
      try {
        repoInfo = await getRepoInfo(repoLink)
        // License
        licenseKey = _.get(repoInfo, 'license.key', '')
        licenseInfo = await getLicenseInfo(licenseKey)
        licenseName = _.get(repoInfo, 'license.name', '') || packageInfo.license
        licenseLink = await getLicenseLink(_.get(repoInfo, 'license.url', ''), licenseName)
        licenseDescription = await getLicenseDescription(licenseInfo, repoInfo)
      } catch (e) {
        console.log("Can't fetch package info from:", repoLink)
        console.log(_.get(e, 'response', e.message))
      }
      console.log('[PACKAGE INFO]:', name, version, licenseName, licenseLink)

      data.push({
        no: i,
        name,
        version,
        license_name: licenseName,
        license_link: licenseLink,
        license_description: licenseDescription
      })
      i++
    }

    csvWriter
      .writeRecords(data)
      .then(()=> console.log('The CSV file was written successfully'));
    fs.writeFileSync(`${exportPath}.json`, JSON.stringify(data))
  } catch (e) {
    console.log(_.get(e, 'response', e.message))
  }
}

function readRootPackageJson(rootFolderPath) {
  const jsonPath = path.join(rootFolderPath, 'package.json')
  const content = fs.readFileSync(jsonPath)
  return JSON.parse(content)
}

async function start() {
  const answers = await inquirer.prompt([
    {
      name: 'path',
      type: 'input',
      message: 'Please tell us the root folder path which contains your packages.json'
    },
    {
      name: 'exportOption',
      type: 'list',
      message: 'Do you want to export dependencies or devDependencies or both',
      choices: [
        OPTION_DEPENDENCIES,
        OPTION_DEV_DEPENDENCIES,
        OPTION_BOTH
      ]
    }
  ])

  const rootFolderPath = answers.path
  const exportOption  = answers.exportOption
  const exportFolderPath = path.join(__dirname, 'output')
  if (!rootFolderPath) {
    console.log('The root path is empty.')
    return
  }

  if (!fs.existsSync(exportFolderPath)) {
    fs.mkdirSync(exportFolderPath)
  }

  let exportingProperties = ['dependencies']
  if (exportOption === OPTION_DEV_DEPENDENCIES) {
    exportingProperties = ['devDependencies']
  } else if (exportOption === OPTION_BOTH) {
    exportingProperties = ['dependencies', 'devDependencies']
  }

  const projectContent = readRootPackageJson(rootFolderPath)

  for (let i = 0; i < exportingProperties.length; i++) {
    const key = exportingProperties[i]
    await writePropertiesToFile(rootFolderPath, projectContent[key], path.join(exportFolderPath, `${projectContent.name}-${key}`))
  }
}

start()