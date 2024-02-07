import { WHITELIST_TOKENS } from './../utils/pricing'
/* eslint-disable prefer-const */
import { FACTORY_ADDRESS, ZERO_BI, ONE_BI, ZERO_BD, ADDRESS_ZERO, pools_list} from './../utils/constants'
import { Factory } from '../types/schema'
import { Pool as PoolEvent } from '../types/Factory/Factory'
import { Pool, Token, Bundle } from '../types/schema'
import { Pool as PoolTemplate} from '../types/templates'
import { fetchTokenSymbol, fetchTokenName, fetchTokenTotalSupply, fetchTokenDecimals } from '../utils/token'
import { log,BigInt } from '@graphprotocol/graph-ts'

export function handlePoolCreated(event: PoolEvent): void {
  // temp fix

  // load factory
  let factory = Factory.load(FACTORY_ADDRESS)
  if (factory == null) {
    factory = new Factory(FACTORY_ADDRESS)
    factory.poolCount = ZERO_BI
    factory.totalVolumeMatic = ZERO_BD
    factory.totalVolumeUSD = ZERO_BD
    factory.untrackedVolumeUSD = ZERO_BD
    factory.totalFeesUSD = ZERO_BD
    factory.totalFeesMatic = ZERO_BD
    factory.totalValueLockedMatic = ZERO_BD
    factory.totalValueLockedUSD = ZERO_BD
    factory.totalValueLockedUSDUntracked = ZERO_BD
    factory.totalValueLockedMaticUntracked = ZERO_BD
    factory.txCount = ZERO_BI
    factory.owner = ADDRESS_ZERO

    // create new bundle for tracking matic price
    let bundle = new Bundle('1')
    bundle.maticPriceUSD = ZERO_BD
    bundle.save()
  }

  factory.poolCount = factory.poolCount.plus(ONE_BI)

  let pool = new Pool(event.params.pool.toHexString()) as Pool
  
  let token0_address = event.params.token0
  let token1_address = event.params.token1

  let token0 = Token.load(token0_address.toHexString())
  let token1 = Token.load(token1_address.toHexString())


  if(pools_list.includes(event.params.pool.toHexString())){
    token0 = Token.load(event.params.token1.toHexString())
    token1 = Token.load(event.params.token0.toHexString())
    token0_address = event.params.token1
    token1_address = event.params.token0  
  }  

  // fetch info if null
  if (token0 === null) {
    token0 = new Token(token0_address.toHexString())
    token0.symbol = fetchTokenSymbol(token0_address)
    token0.name = fetchTokenName(token0_address)
    token0.totalSupply = fetchTokenTotalSupply(token0_address)
    let decimals = fetchTokenDecimals(token0_address)

    // bail if we couldn't figure out the decimals
    if (decimals === null) {
      log.debug('mybug the decimal on token 0 was null', [])
      return
    }

    token0.decimals = decimals
    token0.derivedMatic = ZERO_BD
    token0.volume = ZERO_BD
    token0.volumeUSD = ZERO_BD
    token0.feesUSD = ZERO_BD
    token0.untrackedVolumeUSD = ZERO_BD
    token0.totalValueLocked = ZERO_BD
    token0.totalValueLockedUSD = ZERO_BD
    token0.totalValueLockedUSDUntracked = ZERO_BD
    token0.txCount = ZERO_BI
    token0.poolCount = ZERO_BI
    token0.whitelistPools = []
  }

  if (token1 === null) {
    token1 = new Token(token1_address.toHexString())
    token1.symbol = fetchTokenSymbol(token1_address)
    token1.name = fetchTokenName(token1_address)
    token1.totalSupply = fetchTokenTotalSupply(token1_address)
    let decimals = fetchTokenDecimals(token1_address)
    // bail if we couldn't figure out the decimals
    if (decimals === null) {
      log.debug('mybug the decimal on token 0 was null', [])
      return
    }
    token1.decimals = decimals
    token1.derivedMatic = ZERO_BD
    token1.volume = ZERO_BD
    token1.volumeUSD = ZERO_BD
    token1.untrackedVolumeUSD = ZERO_BD
    token1.feesUSD = ZERO_BD
    token1.totalValueLocked = ZERO_BD
    token1.totalValueLockedUSD = ZERO_BD
    token1.totalValueLockedUSDUntracked = ZERO_BD
    token1.txCount = ZERO_BI
    token1.poolCount = ZERO_BI
    token1.whitelistPools = []
  }

  // update white listed pools
  if (WHITELIST_TOKENS.includes(token0.id)) {
    let newPools = token1.whitelistPools
    newPools.push(pool.id)
    token1.whitelistPools = newPools
  }
  if (WHITELIST_TOKENS.includes(token1.id)) {
    let newPools = token0.whitelistPools
    newPools.push(pool.id)
    token0.whitelistPools = newPools
  }

  pool.token0 = token0.id
  pool.token1 = token1.id
  pool.fee = BigInt.fromI32(100)
  pool.createdAtTimestamp = event.block.timestamp
  pool.createdAtBlockNumber = event.block.number
  pool.liquidityProviderCount = ZERO_BI
  pool.txCount = ZERO_BI
  pool.liquidity = ZERO_BI
  pool.sqrtPrice = ZERO_BI
  pool.feeGrowthGlobal0X128 = ZERO_BI
  pool.feeGrowthGlobal1X128 = ZERO_BI
  pool.communityFee0 = ZERO_BI
  pool.communityFee1 = ZERO_BI
  pool.token0Price = ZERO_BD
  pool.token1Price = ZERO_BD
  pool.observationIndex = ZERO_BI
  pool.totalValueLockedToken0 = ZERO_BD
  pool.totalValueLockedToken1 = ZERO_BD
  pool.totalValueLockedUSD = ZERO_BD
  pool.totalValueLockedMatic = ZERO_BD
  pool.totalValueLockedUSDUntracked = ZERO_BD
  pool.volumeToken0 = ZERO_BD
  pool.volumeToken1 = ZERO_BD
  pool.volumeUSD = ZERO_BD
  pool.feesUSD = ZERO_BD
  pool.feesToken0 = ZERO_BD
  pool.feesToken1 = ZERO_BD
  pool.untrackedVolumeUSD = ZERO_BD

  pool.collectedFeesToken0 = ZERO_BD
  pool.collectedFeesToken1 = ZERO_BD
  pool.collectedFeesUSD = ZERO_BD

  pool.save()
  // create the tracked contract based on the template
  PoolTemplate.create(event.params.pool)
  token0.save()
  token1.save()
  factory.save()

}
